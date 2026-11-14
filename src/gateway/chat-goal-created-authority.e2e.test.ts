import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// Prepare real agent/Gateway declarations during collection, outside the proof deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { getSubagentRunByRunId } from "../agents/subagents/registry/subagent-registry.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { productModelConfig, productProvider } from "./server.chat-product.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

function spawnReceipt(value: unknown): { runId: string; childSessionKey: string } | undefined {
  if (typeof value === "string") {
    try {
      return spawnReceipt(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (
    "runId" in value &&
    "childSessionKey" in value &&
    typeof value.runId === "string" &&
    typeof value.childSessionKey === "string"
  ) {
    return { runId: value.runId, childSessionKey: value.childSessionKey };
  }
  return Object.values(value)
    .map(spawnReceipt)
    .find((receipt) => receipt !== undefined);
}

function assistantText(value: unknown): string | undefined {
  const message = asOptionalRecord(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  return message.content
    .map((block) => {
      const part = asOptionalRecord(block);
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function transcriptContent(messages: unknown[] | undefined) {
  return messages?.map((value) => {
    const message = asOptionalRecord(value);
    return {
      id: asOptionalRecord(message?.["__openclaw"])?.id,
      role: message?.role,
      content: message?.content,
    };
  });
}

// Fixed provider decisions; real identified operators, tools, authority and persisted effects.
it(
  "preserves restricted Goal returns and cancels revoked returns before further effects",
  { timeout: 120_000 },
  async ({ signal }) => {
    const state = await createOpenClawTestState({
      label: "goal-created-authority",
      prepareProfileCatalog: true,
      env: {
        ...KERNEL_TEST_ENV,
        VITEST: process.env.VITEST,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const adminProfile = ensureProfileForEmail("admin@goal-authority.example.test");
    setUserProfileRole(adminProfile.id, "administrator");
    const scenarios = [false, true].map((revoke) => {
      const name = revoke ? "revoke" : "current";
      const profile = ensureProfileForEmail(`${name}@goal-authority.example.test`);
      const nonce = randomUUID();
      return {
        name,
        revoke,
        profile,
        prompt: `GOAL_AUTHORITY_${nonce}`,
        childTask: `CHILD_AUTHORITY_${nonce}`,
        childResult: `CHILD_DONE_${nonce}`,
        parentCalls: 0,
        childCalls: 0,
        sessionKey: "",
        childRunId: undefined as string | undefined,
        releaseChild: createDeferredCore(),
        yielded: createDeferredCore(),
        childStarted: createDeferredCore(),
        settlementEntered: createDeferredCore(),
        releaseSettlement: createDeferredCore(),
        providerCancelled: createDeferredCore(),
        finalText: `GOAL_COMPLETE_${nonce}`,
        finalReceived: createDeferredCore(),
      };
    });
    cleanup.defer(() => {
      for (const scenario of scenarios) {
        scenario.releaseChild.resolve();
        scenario.releaseSettlement.resolve();
      }
    });
    const failed = createDeferredCore<never>();
    void failed.promise.catch(() => {});
    const wait = <T>(work: Promise<T>) => withinTest(Promise.race([work, failed.promise]), signal);
    const errors: unknown[] = [];
    const provider = productProvider(errors, async (text, response) => {
      const reply = (value: string) =>
        writeOpenAiResponsesText(response, {
          text: value,
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      try {
        if (text.includes("conversationLabelSource")) {
          reply("Synthetic Goal authority");
          return;
        }
        const scenario =
          scenarios.find((entry) => text.includes(entry.prompt)) ??
          scenarios.find((entry) => text.includes(entry.childTask));
        assert(scenario, "only synthetic Goal conversations may call this provider");
        if (!text.includes(scenario.prompt) && text.includes(scenario.childTask)) {
          scenario.childCalls++;
          expect(scenario.childCalls).toBe(1);
          scenario.childStarted.resolve();
          await wait(scenario.releaseChild.promise);
          reply(scenario.childResult);
          return;
        }
        scenario.parentCalls++;
        const body = JSON.parse(text) as { input?: Array<{ type?: string; output?: unknown }> };
        const output = body.input?.findLast((item) => item.type === "function_call_output")?.output;
        if (scenario.parentCalls === 1) {
          writeToolCall(response, "create_goal", { objective: scenario.prompt });
        } else if (scenario.parentCalls === 2) {
          expect(JSON.stringify(output)).toContain("created");
          writeToolCall(response, "sessions_spawn", {
            task: scenario.childTask,
            agentId: "main",
            runtime: "subagent",
            context: "isolated",
            cleanup: "keep",
            completionTarget: "parent",
          });
        } else if (scenario.parentCalls === 3) {
          scenario.childRunId = spawnReceipt(output)?.runId;
          assert(scenario.childRunId, "spawn must return its actual child run");
          writeToolCall(response, "sessions_yield", {});
        } else if (scenario.parentCalls === 4) {
          expect(text).toContain(scenario.childResult);
          expect(text).toContain("Active goal:");
          // Hold actual provider I/O only after the committed child return admitted
          // requester completion. Revocation must cancel this retained operator.
          response.once("close", () => {
            if (!response.writableFinished) {
              scenario.providerCancelled.resolve();
            }
          });
          scenario.settlementEntered.resolve();
          if (scenario.revoke) {
            await wait(scenario.releaseSettlement.promise);
          }
          if (!response.destroyed) {
            writeToolCall(response, "sessions_create", {
              agentId: "sibling",
              label: `Forbidden ${scenario.name}`,
            });
          }
        } else if (scenario.parentCalls === 5) {
          expect(scenario.revoke).toBe(false);
          expect((JSON.stringify(output) ?? "").replaceAll("\\", "")).toContain(
            'cannot create sessions for agent "sibling"',
          );
          reply("The delegated item is done. The remaining Goal item is unfinished.");
        } else if (scenario.parentCalls === 6) {
          expect(scenario.revoke).toBe(false);
          expect(text).toContain("Advance the active goal");
          writeToolCall(response, "update_goal", { status: "complete" });
        } else if (scenario.parentCalls === 7) {
          expect(scenario.revoke).toBe(false);
          reply(scenario.finalText);
        } else {
          throw new Error("Unexpected Goal authority provider request");
        }
      } catch (error) {
        failed.reject(error);
        throw error;
      }
    });
    cleanup.defer(() => closeProvider(provider));
    const model = buildMockOpenAiResponsesProvider(
      await listenProvider(provider),
      "goal-authority-fixture",
    );
    const { defaults, models } = productModelConfig(state.workspaceDir, model);
    const scopes: OperatorScope[] = ["operator.read", "operator.write"];
    const origin = "https://control.example.test";
    const auth: GatewayAuthConfig = {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: ["admin", "current", "revoke"].map(
          (name) => `${name}@goal-authority.example.test`,
        ),
        allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes },
      },
      identityScopes: { "admin@goal-authority.example.test": ["operator.admin"] },
    };
    const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
    const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, sibling: {} }, defaults },
      models,
      plugins: { enabled: false, slots: { memory: "none" } },
      tools: {
        allow: [
          "create_goal",
          "update_goal",
          "sessions_spawn",
          "sessions_yield",
          "sessions_create",
        ],
        toolSearch: false,
        codeMode: { enabled: false },
      },
      messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: { allowedOrigins: [origin] },
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        roles: {
          default: "member",
          definitions: {
            administrator: {
              agents: "*",
              sessions: { others: "write" },
              scopes: ["operator.admin"],
            },
            member: { agents: ["main"], sessions: { others: "write" }, scopes },
            revoked: { agents: [], sessions: { others: "none" }, scopes: ["operator.read"] },
          },
        },
      },
    };
    const headers = (name: string) => ({
      "x-forwarded-user": `${name}@goal-authority.example.test`,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.50",
    });
    const connection = {
      clientName: "openclaw-control-ui" as const,
      mode: "webchat" as const,
      origin,
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    };
    const publicationText = `POST_REVOCATION_${randomUUID()}`;
    const authorizedEvents: Array<{ event?: string; payload?: unknown }> = [];
    const authorizedPublication = createDeferredCore();
    const gateway = await startGatewayWithClient({
      ...connection,
      cfg,
      configPath: state.configPath,
      auth,
      secure: true,
      scopes: ["operator.admin"],
      edgeAuthHeaders: headers("admin"),
      onEvent: (event) => {
        authorizedEvents.push(event);
        const payload = asOptionalRecord(event.payload);
        if (
          event.event === "session.message" &&
          assistantText(payload?.message) === publicationText
        ) {
          authorizedPublication.resolve();
        }
      },
    });
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Goal authority proof complete" });
    });
    await gateway.server.startupSettled;
    const admin = gateway.client;
    for (const scenario of scenarios) {
      const events: Array<{ event?: string; payload?: unknown }> = [];
      const member = await connectGatewayClient({
        ...connection,
        url: `wss://127.0.0.1:${gateway.port}`,
        scopes,
        edgeAuthHeaders: headers(scenario.name),
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.path(scenario.name, "client", "credentials.sqlite"),
        }),
        onEvent: (event) => {
          events.push(event);
          const payload = asOptionalRecord(event.payload);
          if (
            event.event === "session.message" &&
            payload?.sessionKey === scenario.sessionKey &&
            assistantText(payload.message) === scenario.finalText
          ) {
            scenario.finalReceived.resolve();
          }
        },
      });
      cleanup.defer(() => disconnectGatewayClient(member));
      expect(await member.request("users.self", {})).toMatchObject({
        profile: { id: scenario.profile.id },
      });
      const created = await member.request<{ key: string }>("sessions.create", {
        agentId: "main",
        label: `Goal ${scenario.name}`,
      });
      scenario.sessionKey = created.key;
      expect(
        await member.request("sessions.messages.subscribe", { key: scenario.sessionKey }),
      ).toMatchObject({ subscribed: true });
      const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
        const child = scenario.childRunId && getSubagentRunByRunId(scenario.childRunId);
        if (child && child.requesterSettleWake?.requesterYieldBatch && !child.requesterTurnRunId) {
          scenario.yielded.resolve();
        }
      });
      try {
        await member.request("chat.send", {
          sessionKey: scenario.sessionKey,
          message: `Please create this Goal, delegate the first item, then attempt an independent sibling-agent session and finish the remaining item: ${scenario.prompt}`,
          idempotencyKey: randomUUID(),
        });
        await wait(Promise.all([scenario.childStarted.promise, scenario.yielded.promise]));
        expect(scenario.parentCalls).toBe(3);
        scenario.releaseChild.resolve();
        await wait(scenario.settlementEntered.promise);
        const beforeRevocation = {
          parent: scenario.parentCalls,
          child: scenario.childCalls,
          events: events.length,
        };
        const beforeHistory = scenario.revoke
          ? await admin.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: scenario.sessionKey,
              limit: 100,
            })
          : undefined;
        let revokedEventBoundary = events.length;
        if (scenario.revoke) {
          expect(
            events.some(
              (event) =>
                event.event === "session.message" &&
                asOptionalRecord(event.payload)?.sessionKey === scenario.sessionKey,
            ),
          ).toBe(true);
          await admin.request("users.setRole", { profileId: scenario.profile.id, role: "revoked" });
          revokedEventBoundary = events.length;
          // Observe the actual provider socket cancellation, not a fixture decision
          // to drop a response. The stale effect is released only after this fact.
          await wait(scenario.providerCancelled.promise);
          scenario.releaseSettlement.resolve();
        }
        const drained = await wait(waitForGatewayActiveWork(30_000));
        expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
        const sibling = await admin.request<{ sessions: unknown[] }>("sessions.list", {
          agentId: "sibling",
        });
        expect(sibling.sessions).toEqual([]);
        expect(scenario.childCalls).toBe(1);
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: scenario.sessionKey })?.goal,
        ).toMatchObject(
          scenario.revoke
            ? { status: "active", continuationTurns: 0 }
            : { status: "complete", continuationTurns: 1 },
        );
        if (!scenario.revoke) {
          await wait(scenario.finalReceived.promise);
        }
        const history = await (scenario.revoke ? admin : member).request<{ messages: unknown[] }>(
          "chat.history",
          { sessionKey: scenario.sessionKey, limit: 100 },
        );
        const finals = events.filter(
          (event) =>
            event.event === "session.message" &&
            asOptionalRecord(event.payload)?.sessionKey === scenario.sessionKey &&
            assistantText(asOptionalRecord(event.payload)?.message) === scenario.finalText,
        );
        expect(finals).toHaveLength(scenario.revoke ? 0 : 1);
        expect(
          history.messages.filter((message) => assistantText(message) === scenario.finalText),
        ).toHaveLength(scenario.revoke ? 0 : 1);
        if (scenario.revoke) {
          // The administrator may still inspect the canonical history; only the
          // revoked requester's publication stream is required to be silent.
          // Role changes refresh projected avatar URLs, not durable message identity/content.
          expect(transcriptContent(history.messages)).toEqual(
            transcriptContent(beforeHistory?.messages),
          );
          expect(
            events.slice(beforeRevocation.events).filter((event) => {
              const payload = asOptionalRecord(event.payload);
              return (
                event.event === "chat" &&
                payload?.sessionKey === scenario.sessionKey &&
                ((payload.state === "final" && payload.message !== undefined) ||
                  (payload.state === "delta" &&
                    (payload.message !== undefined || payload.deltaText !== undefined)))
              );
            }),
          ).toEqual([]);
          // Role changes retire the old subscription; the client may reconnect read-only.
          // Assert disclosure after a real publication, not transient transport state.
          expect(
            await admin.request("sessions.messages.subscribe", { key: scenario.sessionKey }),
          ).toMatchObject({ subscribed: true });
          expect(
            await admin.request("chat.inject", {
              sessionKey: scenario.sessionKey,
              message: publicationText,
            }),
          ).toMatchObject({ ok: true });
          await wait(authorizedPublication.promise);
          const publicationDrained = await wait(waitForGatewayActiveWork(30_000));
          expect(publicationDrained.drained).toBe(true);
          const afterPublication = await admin.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: scenario.sessionKey,
            limit: 100,
          });
          expect(
            authorizedEvents.filter(
              (event) =>
                event.event === "session.message" &&
                asOptionalRecord(event.payload)?.sessionKey === scenario.sessionKey &&
                assistantText(asOptionalRecord(event.payload)?.message) === publicationText,
            ),
          ).toHaveLength(1);
          expect(afterPublication.messages).toHaveLength(history.messages.length + 1);
          expect(transcriptContent(afterPublication.messages.slice(0, -1))).toEqual(
            transcriptContent(history.messages),
          );
          expect(assistantText(afterPublication.messages.at(-1))).toBe(publicationText);
          expect(
            events.slice(revokedEventBoundary).filter((event) => {
              const payload = asOptionalRecord(event.payload);
              return (
                payload?.sessionKey === scenario.sessionKey &&
                (event.event === "session.message" ||
                  (event.event === "chat" &&
                    (payload.message !== undefined || payload.deltaText !== undefined)))
              );
            }),
          ).toEqual([]);
          expect(scenario.parentCalls).toBe(beforeRevocation.parent);
          expect(scenario.childCalls).toBe(beforeRevocation.child);
        } else {
          expect(scenario.parentCalls).toBe(7);
        }
        expect(errors).toEqual([]);
      } finally {
        scenario.releaseChild.resolve();
        scenario.releaseSettlement.resolve();
        unsubscribe();
      }
    }
  },
);
