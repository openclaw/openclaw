import assert from "node:assert/strict";
// Real HTTP model/tool, committed child settlement, and WebSocket reply effects.
// Do not import test-helpers.js: that graph replaces the agent execution boundary.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID, X509Certificate } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { getSubagentRunByRunId } from "../agents/subagents/registry/subagent-registry.js";
import * as followupDrain from "../auto-reply/reply/queue/drain.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createDeferredCore } from "../shared/deferred.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
type SpawnReceipt = { runId: string; childSessionKey: string };
type Reply = { recipient: string; sessionKey: unknown; payload: unknown };
const scopes: Array<"operator.read" | "operator.write"> = ["operator.read", "operator.write"];
const cases = [
  { label: "allowed return preserves scope and recipient through two hidden nudges", gate: "none" },
  { label: "role revocation after child commit blocks final Goal enqueue", gate: "enqueue" },
  { label: "profile reassignment after enqueue blocks continuation dispatch", gate: "dispatch" },
] as const;

/** Decode actual model-visible tool outputs, never fabricate owner receipts. */
function records(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return records(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap(records);
  }
  const record = asOptionalRecord(value);
  return record ? [record, ...Object.values(record).flatMap(records)] : [];
}

function latestToolOutput(body: string) {
  const output = records(JSON.parse(body) as unknown).findLast(
    (record) => record.type === "function_call_output",
  );
  return records(output?.output);
}

function createScenario(index: number, scenario: (typeof cases)[number]) {
  const marker = "GOAL_AUTHORITY_" + index + "_" + randomUUID();
  return {
    ...scenario,
    email: "goal-authority-" + index + "@example.test",
    sessionKey: "agent:main:goal-authority-" + index,
    sessionId: "goal-authority-session-" + index,
    prompt: marker + " Finish the objective with a delegated first item and two further checks.",
    childTask: "CHILD_" + marker + " Return the isolated first-item finding.",
    childResult: "CHILD_RESULT_" + marker,
    requesterFinal: "REQUESTER_FINAL_" + marker,
    nudgeFinal: "NUDGE_ONE_FINAL_" + marker,
    completeFinal: "GOAL_COMPLETE_FINAL_" + marker,
    forbiddenTask: "FORBIDDEN_EFFECT_" + marker,
    childRelease: createDeferredCore(),
    childStarted: createDeferredCore(),
    yielded: createDeferredCore(),
    committed: createDeferredCore(),
    held: createDeferredCore(),
    releaseRead: createDeferredCore(),
    requesterDelivered: createDeferredCore(),
    failed: createDeferredCore<never>(),
    receipt: undefined as SpawnReceipt | undefined,
    releaseDrain: undefined as (() => void) | undefined,
    requests: 0,
    replies: [] as Reply[],
    replyEffects: [] as unknown[],
    toolEffects: [] as unknown[],
    parentCalls: 0,
    childCalls: 0,
    readHeld: false,
    drainHeld: false,
    profileId: "",
  };
}
type Scenario = ReturnType<typeof createScenario>;

function textReply(response: ServerResponse, text: string) {
  writeOpenAiResponsesText(response, {
    text,
    messageId: "msg_" + randomUUID(),
    responseId: "resp_" + randomUUID(),
  });
}

function spawn(scenario: Scenario, response: ServerResponse, agentId: "main" | "forbidden") {
  writeToolCall(response, "sessions_spawn", {
    task: agentId === "main" ? scenario.childTask : scenario.forbiddenTask,
    agentId,
    runtime: "subagent",
    context: "isolated",
    cleanup: "keep",
    completionTarget: "parent",
  });
}

function expectRoleDenial(scenario: Scenario, body: string) {
  const roleError = 'Your operator role cannot create sessions for agent "forbidden"';
  const denied = latestToolOutput(body).find(
    (record) => typeof record.error === "string" && record.error.includes(roleError),
  );
  // Require the named role rejection, not a generic failure or sender-only policy.
  expect(denied, "sibling spawn must fail at the original human's role boundary").toMatchObject({
    status: expect.stringMatching(/^(error|forbidden)$/),
    error: expect.stringContaining(roleError),
  });
}

/** Finite script: spawn -> yield -> scoped requester -> two scoped hidden nudges -> complete. */
async function answer(scenario: Scenario, body: string, response: ServerResponse) {
  scenario.requests++;
  if (!body.includes(scenario.prompt) && body.includes(scenario.childTask)) {
    scenario.childCalls++;
    expect(scenario.childCalls, "allowed child executes once").toBe(1);
    scenario.childStarted.resolve();
    await scenario.childRelease.promise;
    textReply(response, scenario.childResult);
    return;
  }
  expect(body, "original Goal stays in requester context").toContain(scenario.prompt);
  scenario.parentCalls++;
  switch (scenario.parentCalls) {
    case 1:
      spawn(scenario, response, "main");
      return;
    case 2: {
      const receipt = latestToolOutput(body).find(
        (record) => typeof record.runId === "string" && typeof record.childSessionKey === "string",
      );
      assert(receipt, "sessions_spawn must return a real child receipt");
      assert(typeof receipt.runId === "string" && typeof receipt.childSessionKey === "string");
      scenario.receipt = { runId: receipt.runId, childSessionKey: receipt.childSessionKey };
      expect(receipt.childSessionKey).toMatch(/^agent:main:subagent:/);
      writeToolCall(response, "sessions_yield", {});
      return;
    }
    case 3:
    case 5:
      if (scenario.parentCalls === 3) {
        expect(body).toContain(scenario.childResult);
      } else {
        expect(body).toContain("Advance the active goal");
        expect(body).toContain(scenario.requesterFinal);
      }
      // Ordinary subagent policy permits every agent. Only the main-only HUMAN role
      // can deny this, including inside the privileged requester-settle command.
      spawn(scenario, response, "forbidden");
      return;
    case 4:
    case 6:
      expectRoleDenial(scenario, body);
      textReply(
        response,
        scenario.parentCalls === 4 ? scenario.requesterFinal : scenario.nudgeFinal,
      );
      return;
    case 7:
      expect(body).toContain("Advance the active goal");
      expect(body).toContain(scenario.nudgeFinal);
      writeToolCall(response, "update_goal", { status: "complete" });
      return;
    case 8:
      textReply(response, scenario.completeFinal);
      return;
    default:
      throw new Error("Unexpected extra Goal model request: " + scenario.parentCalls);
  }
}

// One suite Gateway/provider. No agent, queue, admission owner or authority assertion is replaced.
describe("Goal child handoff retains scoped human authority at real effects", () => {
  const scenarios = cases.map((scenario, index) => createScenario(index, scenario));
  const clients = new Map<string, Client>();
  const providerErrors: unknown[] = [];
  const forbiddenRequests: string[] = [];
  const cleanups: Array<() => Promise<unknown>> = [];
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;

  const receive = (recipient: string) => (event: { event?: string; payload?: unknown }) => {
    const payload = asOptionalRecord(event.payload);
    const target = scenarios.find((scenario) => scenario.sessionKey === payload?.sessionKey);
    if (target && event.event === "agent" && payload?.stream === "tool") {
      target.toolEffects.push({ recipient, payload });
    }
    if (
      target &&
      (event.event === "session.message" ||
        (event.event === "chat" && ["delta", "final"].includes(String(payload?.state))))
    ) {
      target.replyEffects.push({ recipient, payload });
    }
    // chat.final may omit text already rendered by session.message.
    if (event.event !== "session.message") {
      return;
    }
    const message = asOptionalRecord(payload?.message);
    if (message?.role !== "assistant") {
      return;
    }
    const rendered = JSON.stringify(message);
    for (const scenario of scenarios) {
      if (
        ![scenario.requesterFinal, scenario.nudgeFinal, scenario.completeFinal].some((text) =>
          rendered.includes(text),
        )
      ) {
        continue;
      }
      scenario.replies.push({ recipient, sessionKey: payload?.sessionKey, payload: message });
      if (rendered.includes(scenario.requesterFinal)) {
        scenario.requesterDelivered.resolve();
      }
    }
  };

  beforeAll(async () => {
    for (const scenario of scenarios) {
      void scenario.failed.promise.catch(() => {});
    }
    state = await createOpenClawTestState(
      kernelGatewayTestStateOptions("goal-child-authority-product"),
    );
    cleanups.push(() => state.cleanup());
    const server = createServer((request, response) => {
      let owner: Scenario | undefined;
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data: ["authority-proof", "forbidden-effect"].map((id) => ({ id, object: "model" })),
            }),
          );
          return;
        }
        assert(request.method === "POST" && request.url === "/v1/responses");
        const body = await readRequestText(request);
        const parsed = asOptionalRecord(JSON.parse(body) as unknown);
        if (parsed?.model === "forbidden-effect") {
          forbiddenRequests.push(body);
          textReply(response, "FORBIDDEN_TARGET_MUST_NOT_EXECUTE");
          return;
        }
        owner =
          scenarios.find((scenario) => body.includes(scenario.prompt)) ??
          scenarios.find((scenario) => body.includes(scenario.childTask));
        assert(owner, "only a test-owned Goal may call the provider");
        await answer(owner, body, response);
      })().catch((error: unknown) => {
        providerErrors.push(error);
        for (const scenario of owner ? [owner] : scenarios) {
          scenario.failed.reject(error);
        }
        // Finish the request to avoid provider retry/backoff during teardown.
        if (!response.headersSent) {
          textReply(response, "Fixture assertion failed; stop this turn.");
        } else {
          response.end();
        }
      });
    });
    const provider = buildMockOpenAiResponsesProvider(
      await listenProvider(server),
      "authority-proof",
    );
    cleanups.push(() => closeProvider(server));
    for (const scenario of scenarios) {
      scenario.profileId = ensureProfileForEmail(scenario.email).id;
      setUserProfileRole(scenario.profileId, "scoped");
    }
    const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
    const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
    const modelConfig = () => ({
      agentRuntime: { id: "openclaw" },
      params: { transport: "sse", openaiWsWarmup: false },
    });
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          forbidden: { model: { primary: provider.providerId + "/forbidden-effect" } },
        },
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: modelConfig(),
            [provider.providerId + "/forbidden-effect"]: modelConfig(),
          },
          subagents: { allowAgents: ["*"] },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [provider.providerId]: {
            ...provider.config,
            request: { allowPrivateNetwork: true },
            models: [
              provider.config.models[0],
              { ...provider.config.models[0], id: "forbidden-effect", name: "Forbidden effect" },
            ],
          },
        },
      },
      plugins: { enabled: false, slots: { memory: "none" } },
      tools: { profile: "coding", toolSearch: false },
      messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowUsers: scenarios.map((scenario) => scenario.email),
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes },
          },
        },
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://control.example.com"] },
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        roles: {
          default: "scoped",
          definitions: {
            // Permit child participation while denying sibling agents.
            scoped: { sessions: { others: "write" }, agents: ["main"], scopes },
            revoked: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] },
          },
        },
      },
    } satisfies OpenClawConfig;
    const connection = {
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: "https://control.example.com",
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
      scopes,
      caps: ["session-scoped-events"],
    };
    const headers = (scenario: Scenario, index: number) => ({
      "x-forwarded-user": scenario.email,
      "x-forwarded-for": "203.0.113." + (100 + index),
      "x-forwarded-proto": "https",
    });
    const first = scenarios[0]!;
    gateway = await startGatewayWithClient({
      ...connection,
      cfg,
      configPath: state.configPath,
      auth: cfg.gateway.auth,
      secure: true,
      portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
      edgeAuthHeaders: headers(first, 0),
    });
    cleanups.push(() => gateway.server.close({ reason: "Goal authority product proof complete" }));
    await gateway.server.startupSettled;
    await disconnectGatewayClient(gateway.client);
    for (const [index, scenario] of scenarios.entries()) {
      const client = await connectGatewayClient({
        ...connection,
        url: "wss://127.0.0.1:" + gateway.port,
        edgeAuthHeaders: headers(scenario, index),
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.statePath("test-devices", String(index), "client", "credentials.sqlite"),
        }),
        onEvent: receive(scenario.email),
      });
      clients.set(scenario.email, client);
      cleanups.push(() => disconnectGatewayClient(client));
    }
  }, 90_000);

  afterAll(async () => {
    for (const scenario of scenarios) {
      scenario.childRelease.resolve();
      scenario.releaseRead.resolve();
      scenario.releaseDrain?.();
    }
    const failures: unknown[] = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Goal authority fixture cleanup failed");
    }
  });

  it(
    "preserves the allowed return and denies revoked or reassigned handoffs",
    { timeout: 90_000 },
    async ({ signal }) => {
      // Global test teardown retires publications: keep the conversations in one test.
      for (const scenario of scenarios) {
        const client = clients.get(scenario.email);
        assert(client);
        const wait = <T>(promise: Promise<T>) =>
          withinTest(Promise.race([promise, scenario.failed.promise]), signal);
        const child = () => scenario.receipt && getSubagentRunByRunId(scenario.receipt.runId);
        const hasGoalCustody = () => {
          const queue = getExistingFollowupQueue(scenario.sessionKey);
          return Boolean(
            queue && [...queue.items, ...queue.inFlight].some((run) => run.goalContinuation),
          );
        };
        const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
          const entry = child();
          if (!entry) {
            return;
          }
          if (entry.requesterSettleWake?.requesterYieldBatch && !entry.requesterTurnRunId) {
            scenario.yielded.resolve();
          }
          if (entry.cleanupCompletedAt !== undefined && !entry.requesterSettleWake) {
            scenario.committed.resolve();
          }
          if (entry.delivery?.status === "suspended") {
            scenario.failed.reject(
              new Error("Child delivery suspended: " + entry.delivery.lastError),
            );
          }
        });
        // Pause after the real read; its consumer still checks current authority on release.
        const readEntry = sessionEntryReads.readSessionEntryReadOnlyInWorker;
        const readControl =
          scenario.gate === "enqueue"
            ? vi
                .spyOn(sessionEntryReads, "readSessionEntryReadOnlyInWorker")
                .mockImplementation(async (...args) => {
                  const result = await readEntry(...args);
                  const entry = child();
                  if (
                    !scenario.readHeld &&
                    args[0].sessionKey === scenario.sessionKey &&
                    args[0].agentId === undefined &&
                    scenario.parentCalls === 4 &&
                    entry?.cleanupCompletedAt !== undefined &&
                    !entry.requesterSettleWake &&
                    !hasGoalCustody()
                  ) {
                    scenario.readHeld = true;
                    scenario.held.resolve();
                    await scenario.releaseRead.promise;
                  }
                  return result;
                })
            : undefined;
        // Hold the existing scheduler callback, never replace enqueue/adoption decisions.
        const schedule = followupDrain.scheduleFollowupDrain;
        const drainControl =
          scenario.gate === "dispatch"
            ? vi.spyOn(followupDrain, "scheduleFollowupDrain").mockImplementation((...args) => {
                if (!scenario.drainHeld && args[0] === scenario.sessionKey && hasGoalCustody()) {
                  scenario.drainHeld = true;
                  scenario.releaseDrain = () => schedule(...args);
                  scenario.held.resolve();
                  return;
                }
                schedule(...args);
              })
            : undefined;
        try {
          expect((await client.request<UsersSelfResult>("users.self", {})).profile.id).toBe(
            scenario.profileId,
          );
          await replaceSessionEntry(
            { agentId: "main", sessionKey: scenario.sessionKey },
            {
              sessionId: scenario.sessionId,
              updatedAt: Date.now(),
              visibility: "read-only",
              createdActor: { type: "human", source: "profile", id: scenario.profileId },
            },
          );
          await client.request("sessions.messages.subscribe", { key: scenario.sessionKey });
          const accepted = await client.request<{ status: string; runId: string }>("chat.send", {
            sessionKey: scenario.sessionKey,
            sessionId: scenario.sessionId,
            message: scenario.prompt,
            idempotencyKey: randomUUID(),
            intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
          });
          expect(accepted.status, scenario.label).toBe("started");
          await wait(Promise.all([scenario.childStarted.promise, scenario.yielded.promise]));
          expect(scenario.parentCalls, "no hidden Goal turn may race an unsettled child").toBe(2);
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.goal?.status,
          ).toBe("active");
          scenario.childRelease.resolve();
          if (scenario.gate !== "none") {
            await wait(scenario.held.promise);
            await wait(
              Promise.all([scenario.committed.promise, scenario.requesterDelivered.promise]),
            );
            expect(scenario.parentCalls).toBe(4);
            expect(
              hasGoalCustody(),
              "gate distinguishes pre-enqueue read from queued dispatch",
            ).toBe(scenario.gate === "dispatch");
            const effects = () => ({
              requests: scenario.requests,
              replies: scenario.replyEffects.length,
              tools: scenario.toolEffects.length,
            });
            const beforeRevocation = effects();
            if (scenario.gate === "enqueue") {
              setUserProfileRole(scenario.profileId, "revoked");
            } else {
              const replacement = ensureProfileForEmail("goal-authority-replacement@example.test");
              setUserProfileRole(replacement.id, "scoped");
              linkEmail(scenario.email, replacement.id);
              expect((await client.request<UsersSelfResult>("users.self", {})).profile.id).toBe(
                replacement.id,
              );
            }
            scenario.releaseRead.resolve();
            drainControl?.mockRestore();
            scenario.releaseDrain?.();
            const drained = await wait(waitForGatewayActiveWork(30_000));
            expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
            // Even the refusal response orders earlier publications on this socket.
            if (scenario.gate === "enqueue") {
              await expect(client.request("users.self", {})).rejects.toMatchObject({
                code: "FORBIDDEN",
                message: expect.stringContaining("operator role changed"),
              });
            } else {
              await client.request("users.self", {});
            }
            expect(effects(), "revocation produces no new provider/tool/reply effects").toEqual(
              beforeRevocation,
            );
            expect(scenario.parentCalls).toBe(4);
            expect(hasGoalCustody()).toBe(false);
          } else {
            await wait(scenario.committed.promise);
            const drained = await wait(waitForGatewayActiveWork(30_000));
            expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
            await client.request("users.self", {});
            expect(scenario.parentCalls, "two nudges finish without a runaway successor").toBe(8);
            expect(
              loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.goal?.status,
            ).toBe("complete");
            expect(scenario.replies.map((reply) => JSON.stringify(reply.payload))).toEqual([
              expect.stringContaining(scenario.requesterFinal),
              expect.stringContaining(scenario.nudgeFinal),
              expect.stringContaining(scenario.completeFinal),
            ]);
          }
          await wait(scenario.committed.promise);
          expect(scenario.childCalls).toBe(1);
          expect(scenario.requests).toBe(scenario.gate === "none" ? 9 : 5);
          expect(scenario.replies).toHaveLength(scenario.gate === "none" ? 3 : 1);
          expect(forbiddenRequests, "human authority prevents forbidden provider I/O").toEqual([]);
          expect(providerErrors).toEqual([]);
          expect(
            scenario.replies.every(
              (reply) =>
                reply.recipient === scenario.email && reply.sessionKey === scenario.sessionKey,
            ),
            "all finals retain the original human conversation recipient",
          ).toBe(true);
          const entry = loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey });
          assert(entry);
          const events = await loadTranscriptEvents({
            agentId: "main",
            sessionKey: scenario.sessionKey,
            sessionId: entry.sessionId,
          });
          const userMessages = events.flatMap((event) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            return message?.role === "user" ? [message] : [];
          });
          // Settlement and continuation input persists for model replay, not displayed history.
          const visibleUserMessages = userMessages.filter((message) => message.display !== false);
          expect(visibleUserMessages, "only the human request is visible").toMatchObject([
            { provenance: { kind: "external_user" }, content: scenario.prompt },
          ]);
          expect(
            userMessages.slice(0, 2),
            "human request and child settlement persist",
          ).toMatchObject([
            { provenance: { kind: "external_user" } },
            {
              display: false,
              provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
            },
          ]);
          expect(JSON.stringify(userMessages[1])).toContain(scenario.childResult);
          const continuationMessages = userMessages.slice(2);
          expect(continuationMessages).toHaveLength(scenario.gate === "none" ? 2 : 0);
          for (const message of continuationMessages) {
            expect(message).toMatchObject({
              display: false,
              provenance: { kind: "internal_system" },
              content: [{ type: "text", text: expect.stringContaining("Advance the active goal") }],
            });
          }
        } finally {
          readControl?.mockRestore();
          scenario.releaseRead.resolve();
          drainControl?.mockRestore();
          scenario.releaseDrain?.();
          scenario.childRelease.resolve();
          unsubscribe();
        }
      }
    },
  );
});
