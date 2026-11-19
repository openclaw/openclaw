// A finished child's continue_work wake must run its next turn (bootstrap#1727).
// Real Gateway, sessions_spawn, continue_work, work dispatcher and session controller;
// only the model provider is a local HTTP fixture.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, X509Certificate } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { listContinuationRecords } from "../auto-reply/continuation/custody/custody-store.js";
import { decodeWorkState } from "../auto-reply/continuation/work-flow-state.js";
import * as workOperatorContinuation from "../auto-reply/continuation/work-operator-continuation.js";
import * as getReply from "../auto-reply/reply/get-reply.js";
import * as queuePolicy from "../auto-reply/reply/queue-policy.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { isSessionRunActiveForKey } from "../sessions/session-controller.queries.js";
import { sessionControllers } from "../sessions/session-controller.storage.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { sleep } from "../utils/sleep.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  createSubagentModelConfig,
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

const MODEL_ID = "finished-child-wake";
const WAKE_MARKER = "[continuation:wake]";
const WAKE_TURN_BOUND_MS = 20_000;
// The incident's wake trailed its child's run end by ~5 s (run end 17:55:39.640, return
// delivered .730, hop-2 wake 44.701). At 0 s the wake can beat the child's return.
const WAKE_DELAY_SECONDS = 5;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await resetSubagentRegistryForTests({ persist: false });
});

/** Mailbox custody for one session at the moment its wake is admitted (H1/H2/H3 evidence). */
function captureControllerState(sessionKey: string) {
  return {
    runActive: isSessionRunActiveForKey(sessionKey),
    owners: [...sessionControllers.values()]
      .filter((owner) => owner.key === sessionKey || owner.aliases.has(sessionKey))
      .map((owner) => ({
        active: owner.active?.phase,
        attached: owner.attachment !== undefined,
        droppedCount: owner.mailbox?.droppedCount,
        claim: owner.mailbox?.claim && { released: owner.mailbox.claim.released },
        entries: owner.mailbox?.entries.map((input) => ({
          phase: input.phase,
          protocolRunId: input.protocolRunId,
          retirementRequested: input.retirementRequested === true,
          claimReleased: input.claim?.released,
          custodyWork: input.custody.work?.size ?? 0,
          custodySettling: input.custody.settling !== undefined,
        })),
      })),
  };
}

type OrderEvent = "run-ended" | "return-delivered" | "wake-prepared";
type OrderMark = { seq: number; event: OrderEvent; sessionKey?: string; runId?: string };

/**
 * One monotonic sequence across existing owner signals: the agent lifecycle end event,
 * the subagent registry's delivered return, and a wake's onPreparedAgentRunStart.
 */
function observeOrder() {
  const marks: OrderMark[] = [];
  const mark = (entry: Omit<OrderMark, "seq">) => {
    marks.push({ seq: marks.length + 1, ...entry });
  };
  const stopLifecycle = onAgentEvent((event) => {
    if (event.stream === "lifecycle" && event.data.phase === "end") {
      mark({ event: "run-ended", sessionKey: event.sessionKey, runId: event.runId });
    }
  });
  const delivered = new Set<string>();
  const stopRegistry = subscribeSubagentRunChanges("projection", () => {
    for (const entry of subagentRuns.values()) {
      if (entry.delivery?.status === "delivered" && !delivered.has(entry.runId)) {
        delivered.add(entry.runId);
        mark({ event: "return-delivered", sessionKey: entry.childSessionKey, runId: entry.runId });
      }
    }
  });
  return {
    mark,
    /** A session's first run end, that run's delivered return, then the session's wakes. */
    sequence: (sessionKey: string, firstRunId: string): OrderEvent[] =>
      marks
        .filter((entry) =>
          entry.event === "wake-prepared"
            ? entry.sessionKey === sessionKey
            : entry.runId === firstRunId,
        )
        .map((entry) => entry.event),
    stop: () => {
      stopLifecycle();
      stopRegistry();
    },
  };
}

type WakeAttempt = {
  sessionKey: string;
  preparedRunStarted: boolean;
  /** Operator policy custody in scope when the wake reached the reply runtime. */
  operatorAuthority?: { profileId: string; scopes: string[]; agents?: "*" | string[] };
  queueDecisions: Array<{
    params: Parameters<typeof queuePolicy.resolveActiveRunQueueAction>[0];
    action: ReturnType<typeof queuePolicy.resolveActiveRunQueueAction>;
    state: ReturnType<typeof captureControllerState>;
  }>;
};

/** Pass-through observation of continuation work wakes; behavior is unchanged. */
function observeWorkWakes(order: ReturnType<typeof observeOrder>) {
  const attempts: WakeAttempt[] = [];
  const current = new AsyncLocalStorage<WakeAttempt>();
  const getReplyFromConfig = getReply.getReplyFromConfig;
  vi.spyOn(getReply, "getReplyFromConfig").mockImplementation(async (ctx, opts, cfg) => {
    if (opts?.continuationTrigger !== "work-wake" || !ctx.SessionKey) {
      return await getReplyFromConfig(ctx, opts, cfg);
    }
    const authority = getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
    const attempt: WakeAttempt = {
      sessionKey: ctx.SessionKey,
      preparedRunStarted: false,
      ...(authority
        ? {
            operatorAuthority: {
              profileId: authority.profileId,
              scopes: [...authority.scopes],
              agents:
                authority.rolePolicy?.agents === "*" ? "*" : authority.rolePolicy?.agents.slice(),
            },
          }
        : {}),
      queueDecisions: [],
    };
    attempts.push(attempt);
    const onPreparedAgentRunStart = opts.onPreparedAgentRunStart;
    return await current.run(attempt, () =>
      getReplyFromConfig(
        ctx,
        {
          ...opts,
          onPreparedAgentRunStart: (run) => {
            attempt.preparedRunStarted = true;
            order.mark({ event: "wake-prepared", sessionKey: attempt.sessionKey });
            return onPreparedAgentRunStart?.(run);
          },
        },
        cfg,
      ),
    );
  });
  const resolveActiveRunQueueAction = queuePolicy.resolveActiveRunQueueAction;
  vi.spyOn(queuePolicy, "resolveActiveRunQueueAction").mockImplementation((params) => {
    const action = resolveActiveRunQueueAction(params);
    const attempt = current.getStore();
    attempt?.queueDecisions.push({
      params,
      action,
      state: captureControllerState(attempt.sessionKey),
    });
    return action;
  });
  return attempts;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() <= deadline) {
    await sleep(50);
  }
}

function continuationConfig(workspace: string, baseUrl: string): OpenClawConfig {
  const cfg = createSubagentModelConfig(workspace, { baseUrl, modelId: MODEL_ID, runtime: true });
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        continuation: { enabled: true, defaultDelayMs: 0, minDelayMs: 0 },
      },
    },
    tools: { ...cfg.tools, alsoAllow: ["continue_work"] },
  };
}

function readToolOutputs(body: string): string[] {
  return ((JSON.parse(body) as { input?: Array<{ type?: string }> }).input ?? [])
    .filter((item) => item.type === "function_call_output")
    .map((item) => JSON.stringify(item));
}

/** The result the model saw for its latest tool call, decoded from the request. */
function readLatestToolResult(body: string): unknown {
  const output = (
    (JSON.parse(body) as { input?: Array<{ type?: string; output?: unknown }> }).input ?? []
  ).findLast((item) => item.type === "function_call_output")?.output;
  return typeof output === "string" ? (JSON.parse(output) as unknown) : output;
}

/** The session's durable continuation work rows (#1488/#1489 custody store). */
async function readWorkRows(sessionKey: string) {
  return (await listContinuationRecords({ ownerSessionKey: sessionKey, kinds: ["work"] })).map(
    (record) => ({
      recordId: record.recordId,
      status: record.status,
      failureReason: record.failureReason,
      terminalNoticePending: record.terminalNoticePending,
      operatorAuthorityRequired: decodeWorkState(record)?.operatorAuthorityRequired === true,
    }),
  );
}

it("runs the next turn of a finished gateway-agent child that elected continue_work", async () => {
  const id = randomUUID().slice(0, 8);
  const parentPrompt = `Spawn the worker for ${id}.`;
  const prompts = {
    child: `Do both halves of task ${id}.`,
    control: `Control turn for ${id}: do both halves.`,
    "agent-rpc": `Agent RPC turn for ${id}: do both halves.`,
  };
  const childResult = `CHILD_FIRST_HALF_${id}`;
  const hopTwoTurns: string[] = [];
  const childAccepted = createDeferred<SpawnReceipt>();
  let sequence = 0;
  const model = await startOpenAiResponsesModelServer({
    modelId: MODEL_ID,
    bindError: "Expected finished-child wake model server address",
    onRequest: async (request, response) => {
      const body = await readRequestText(request);
      const reply = (text: string) => {
        const replyId = `wake_${++sequence}`;
        writeOpenAiResponsesText(response, {
          text,
          messageId: replyId,
          responseId: `${replyId}_response`,
        });
      };
      if (body.includes(parentPrompt)) {
        if (body.includes(childResult) || body.includes("SECOND_HALF_DONE")) {
          reply(`Parent saw the child result for ${id}.`);
        } else if (!body.includes("function_call_output")) {
          writeToolCall(response, "sessions_spawn", {
            task: prompts.child,
            context: "isolated",
            cleanup: "keep",
          });
        } else {
          const receipt = findSubagentSpawnReceipt(JSON.parse(body) as unknown);
          if (receipt) {
            childAccepted.resolve(receipt);
          } else {
            childAccepted.reject(
              new Error(`sessions_spawn refused: ${readToolOutputs(body).join("\n")}`),
            );
          }
          reply("Child accepted.");
        }
        return;
      }
      const label = (Object.keys(prompts) as Array<keyof typeof prompts>).find((key) =>
        body.includes(prompts[key]),
      );
      if (!label) {
        reply("Unexpected request.");
      } else if (body.includes(WAKE_MARKER)) {
        hopTwoTurns.push(label);
        reply(`${label}_SECOND_HALF_DONE`);
      } else if (!body.includes("function_call_output")) {
        writeToolCall(response, "continue_work", {
          reason: `finish the second half of ${label}`,
          delaySeconds: WAKE_DELAY_SECONDS,
        });
      } else {
        reply(label === "child" ? childResult : `${label}_FIRST_HALF_DONE`);
      }
    },
  });
  // Wakes drive the full reply runtime; a child's wake may precede the first chat
  // dispatch that marks the runtime config complete for the fast-reply test guard.
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  const state = await createOpenClawTestState({ label: "finished-child-wake" });
  const gateway = await startGatewayWithClient({
    cfg: continuationConfig(state.workspaceDir, `${model.baseUrl}/v1`),
    configPath: state.configPath,
    token: "finished-child-wake-token",
  });
  const order = observeOrder();
  const wakes = observeWorkWakes(order);
  const outcome = async (label: keyof typeof prompts, sessionKey: string, firstRunId: string) => {
    await waitFor(() => hopTwoTurns.includes(label), WAKE_TURN_BOUND_MS);
    return {
      label,
      hopTwoTurns: hopTwoTurns.filter((turn) => turn === label).length,
      wakes: wakes.filter((wake) => wake.sessionKey === sessionKey),
      order: order.sequence(sessionKey, firstRunId),
    };
  };
  const ranOnce = {
    hopTwoTurns: 1,
    wakes: [expect.objectContaining({ preparedRunStarted: true })],
  };
  try {
    await gateway.server.startupSettled;

    // Fossil: the child's turn was launched in-process by the parent's sessions_spawn tool.
    await gateway.client.request(
      "agent",
      {
        sessionKey: `agent:main:wake-parent-${id}`,
        message: parentPrompt,
        idempotencyKey: `wake-parent-${id}`,
        deliver: false,
      },
      { expectFinal: true },
    );
    const child = await childAccepted.promise;
    // Barrier: the child's first run ends and its return reaches the parent, as in the incident.
    await waitFor(
      () => order.sequence(child.childSessionKey, child.runId).includes("return-delivered"),
      WAKE_TURN_BOUND_MS,
    );
    const fossil = await outcome("child", child.childSessionKey, child.runId);

    // Control: same key shape and lane, but the previous turn came through the reply runner.
    const controlKey = `agent:main:subagent:wake-control-${id}`;
    const controlRun = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: controlKey,
      message: prompts.control,
      idempotencyKey: `wake-control-${id}`,
      deliver: false,
    });
    const control = await outcome("control", controlKey, controlRun.runId);

    // Discriminator: a gateway agent RPC turn from an operator client, with no spawning tool.
    const agentRpcKey = `agent:main:subagent:wake-agent-rpc-${id}`;
    const agentRpcRun = await gateway.client.request<{ runId: string }>(
      "agent",
      {
        sessionKey: agentRpcKey,
        message: prompts["agent-rpc"],
        idempotencyKey: `wake-agent-rpc-${id}`,
        deliver: false,
      },
      { expectFinal: true },
    );
    const agentRpc = await outcome("agent-rpc", agentRpcKey, agentRpcRun.runId);

    console.log(`[finished-child-wake] ${JSON.stringify({ fossil, control, agentRpc }, null, 2)}`);
    expect(control).toMatchObject({ ...ranOnce, order: ["run-ended", "wake-prepared"] });
    expect(agentRpc).toMatchObject({ ...ranOnce, order: ["run-ended", "wake-prepared"] });
    // Up to the wake: the child's first run ended, then its return was delivered.
    expect(fossil.order.slice(0, 2)).toEqual(["run-ended", "return-delivered"]);
    expect(fossil).toMatchObject({
      ...ranOnce,
      order: ["run-ended", "return-delivered", "wake-prepared"],
    });
  } finally {
    order.stop();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "finished-child wake proof complete" });
    await model.close();
    await state.cleanup();
  }
}, 180_000);

// R-CW-TOKEN (bootstrap#1727 defect 1b): a light-context, delete-mode child ends its first
// answer with a bare CONTINUE_WORK token instead of calling continue_work. Its own turn parks
// that work. The fast parent takes the first answer, and its cleanup finishes before the wake;
// the next turn's answer must still reach the parent, with the work run once.
it("returns a bare CONTINUE_WORK child's next-turn answer to its parent, running the work once", async () => {
  const id = randomUUID().slice(0, 8);
  const parentPrompt = `Spawn the token worker for ${id}.`;
  const childTask = `Token task ${id}: answer, then continue.`;
  const hopOne = `TOKEN-HOP1 ${id}`;
  const hopTwo = `TOKEN-HOP2-DONE ${id}`;
  const parentSaw: string[] = [];
  let hopTwoTurns = 0;
  const childAccepted = createDeferred<SpawnReceipt>();
  let sequence = 0;
  const model = await startOpenAiResponsesModelServer({
    modelId: MODEL_ID,
    bindError: "Expected token wake model server address",
    onRequest: async (request, response) => {
      const body = await readRequestText(request);
      const reply = (text: string) => {
        const replyId = `token_wake_${++sequence}`;
        writeOpenAiResponsesText(response, {
          text,
          messageId: replyId,
          responseId: `${replyId}_response`,
        });
      };
      if (body.includes(parentPrompt)) {
        if (body.includes(hopTwo)) {
          parentSaw.push("hop-2");
          reply(`Parent saw hop 2 for ${id}.`);
        } else if (body.includes(hopOne)) {
          parentSaw.push("hop-1");
          reply(`Parent saw hop 1 for ${id}.`);
        } else if (!body.includes("function_call_output")) {
          writeToolCall(response, "sessions_spawn", {
            task: childTask,
            context: "isolated",
            cleanup: "delete",
            lightContext: true,
          });
        } else {
          const receipt = findSubagentSpawnReceipt(JSON.parse(body) as unknown);
          if (receipt) {
            childAccepted.resolve(receipt);
          } else {
            childAccepted.reject(
              new Error(`sessions_spawn refused: ${readToolOutputs(body).join("\n")}`),
            );
          }
          reply("Child accepted.");
        }
      } else if (!body.includes(childTask)) {
        reply("Unexpected request.");
      } else if (body.includes(WAKE_MARKER)) {
        hopTwoTurns++;
        reply(hopTwo);
      } else {
        reply(`${hopOne}\n\nCONTINUE_WORK:${WAKE_DELAY_SECONDS}`);
      }
    },
  });
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  const state = await createOpenClawTestState({ label: "finished-child-token-wake" });
  const gateway = await startGatewayWithClient({
    cfg: continuationConfig(state.workspaceDir, `${model.baseUrl}/v1`),
    configPath: state.configPath,
    token: "finished-child-token-wake-token",
  });
  try {
    await gateway.server.startupSettled;
    await gateway.client.request(
      "agent",
      {
        sessionKey: `agent:main:token-parent-${id}`,
        message: parentPrompt,
        idempotencyKey: `token-parent-${id}`,
        deliver: false,
      },
      { expectFinal: true },
    );
    const child = await childAccepted.promise;
    await waitFor(() => parentSaw.includes("hop-2"), 3 * WAKE_TURN_BOUND_MS);
    // A second scheduling of the same work would wake the child again after its delay.
    await sleep((WAKE_DELAY_SECONDS + 3) * 1000);
    const workRows = await readWorkRows(child.childSessionKey);
    console.log(
      `[finished-child-token-wake] ${JSON.stringify({ parentSaw, hopTwoTurns, workRows })}`,
    );
    expect(parentSaw).toEqual(["hop-1", "hop-2"]);
    expect(hopTwoTurns).toBe(1);
    expect(workRows).toHaveLength(1);
  } finally {
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "finished-child token wake proof complete" });
    await model.close();
    await state.cleanup();
  }
}, 180_000);

// The fix schedules post-turn continue_work outside the tool caller and operator tool
// frames. An operator's own agent RPC turn keeps its request-scope custody (#1489).
// The chained gates arm hop 3 from hop 2's wake turn; "chained-revoked" revokes between them.
it("keeps a restricted operator's agent-RPC continue_work custody through its wake", async () => {
  const id = randomUUID().slice(0, 8);
  const scopes: OperatorScope[] = ["operator.read", "operator.write"];
  const roleError = 'Your operator role cannot create sessions for agent "forbidden"';
  const gates = ["retained", "revoked", "reassigned", "chained", "chained-revoked"] as const;
  const scenarios = gates.map((gate, index) => ({
    gate,
    email: `wake-operator-${gate}-${id}@example.test`,
    sessionKey: `agent:main:wake-operator-${gate}-${id}`,
    prompt: `Operator ${gate} turn for ${id}: do both halves.`,
    forbiddenTask: `FORBIDDEN_EFFECT_${gate}_${id}`,
    headers: {
      "x-forwarded-user": `wake-operator-${gate}-${id}@example.test`,
      "x-forwarded-for": `203.0.113.${100 + index}`,
      "x-forwarded-proto": "https",
    },
    profileId: "",
    chained: gate.startsWith("chained"),
    hopTwoTurns: 0,
    hopThreeTurns: 0,
    requests: 0,
    requestsAtRevocation: undefined as number | undefined,
    spawnResult: undefined as unknown,
  }));
  const forbiddenRequests: string[] = [];
  let sequence = 0;
  const model = await startOpenAiResponsesModelServer({
    modelId: MODEL_ID,
    bindError: "Expected operator wake model server address",
    onRequest: async (request, response) => {
      const body = await readRequestText(request);
      const reply = (text: string) => {
        const replyId = `operator_wake_${++sequence}`;
        writeOpenAiResponsesText(response, {
          text,
          messageId: replyId,
          responseId: `${replyId}_response`,
        });
      };
      const scenario = scenarios.find((entry) => body.includes(entry.prompt));
      const wakeCount = body.split(WAKE_MARKER).length - 1;
      const hopThreeReason = `arm the third part of ${scenario?.gate}`;
      if (scenario) {
        scenario.requests++;
      }
      if (scenario?.chained && wakeCount > 1) {
        scenario.hopThreeTurns++;
        reply(`${scenario.gate}_THIRD_PART_DONE`);
      } else if (scenario?.chained && wakeCount === 1 && !body.includes(hopThreeReason)) {
        scenario.hopTwoTurns++;
        // Hop 2 runs under hop 1's retained custody and arms hop 3 from it.
        writeToolCall(response, "continue_work", {
          reason: hopThreeReason,
          delaySeconds: WAKE_DELAY_SECONDS,
        });
      } else if (scenario?.chained && wakeCount === 1) {
        reply(`${scenario.gate}_SECOND_PART_DONE`);
      } else if (!scenario) {
        // Only a broader-than-role wake could start the forbidden agent's turn.
        const forbidden = scenarios.find((entry) => body.includes(entry.forbiddenTask));
        if (forbidden) {
          forbiddenRequests.push(forbidden.gate);
        }
        reply("Unexpected request.");
      } else if (body.includes(WAKE_MARKER) && !body.includes(scenario.forbiddenTask)) {
        scenario.hopTwoTurns++;
        // The role admits agent "main" only; ambient authority would admit this spawn.
        writeToolCall(response, "sessions_spawn", {
          task: scenario.forbiddenTask,
          agentId: "forbidden",
          runtime: "subagent",
          context: "isolated",
          cleanup: "keep",
        });
      } else if (body.includes(WAKE_MARKER)) {
        scenario.spawnResult = readLatestToolResult(body);
        reply(`${scenario.gate}_SECOND_HALF_DONE`);
      } else if (!body.includes("function_call_output")) {
        writeToolCall(response, "continue_work", {
          reason: `finish the second half of ${scenario.gate}`,
          delaySeconds: WAKE_DELAY_SECONDS,
        });
      } else {
        reply(`${scenario.gate}_FIRST_HALF_DONE`);
      }
    },
  });
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  const state = await createOpenClawTestState(
    kernelGatewayTestStateOptions("finished-child-wake-operator"),
  );
  for (const scenario of scenarios) {
    scenario.profileId = ensureProfileForEmail(scenario.email).id;
    setUserProfileRole(scenario.profileId, "scoped");
  }
  const base = continuationConfig(state.workspaceDir, `${model.baseUrl}/v1`);
  const origin = "https://control.example.com";
  const cfg = {
    ...base,
    agents: { ...base.agents, ownership: "explicit", entries: { main: {}, forbidden: {} } },
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
      controlUi: { allowedOrigins: [origin] },
      tls: {
        enabled: true,
        autoGenerate: false,
        certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
        keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
      },
      roles: {
        default: "scoped",
        definitions: {
          scoped: { sessions: { others: "write" }, agents: ["main"], scopes },
          revoked: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] },
        },
      },
    },
  } satisfies OpenClawConfig;
  const connection = {
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    origin,
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    scopes,
  };
  const gateway = await startGatewayWithClient({
    ...connection,
    cfg,
    configPath: state.configPath,
    auth: cfg.gateway.auth,
    secure: true,
    portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
    edgeAuthHeaders: expectDefined(scenarios[0], "Expected an operator scenario").headers,
  });
  const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
  const order = observeOrder();
  const wakes = observeWorkWakes(order);
  const retained: Array<{ flowId: string; sessionKey: string; authority: unknown }> = [];
  const retain = workOperatorContinuation.retainWorkOperatorContinuation;
  vi.spyOn(workOperatorContinuation, "retainWorkOperatorContinuation").mockImplementation(
    (flowId, sessionKey, custody) => {
      if (custody) {
        retained.push({ flowId, sessionKey, authority: custody.operatorAuthority });
      }
      retain(flowId, sessionKey, custody);
    },
  );
  try {
    await gateway.server.startupSettled;
    await disconnectGatewayClient(gateway.client);
    const results = [];
    for (const [index, scenario] of scenarios.entries()) {
      const client = await connectGatewayClient({
        ...connection,
        url: `wss://127.0.0.1:${gateway.port}`,
        edgeAuthHeaders: scenario.headers,
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.statePath("test-devices", String(index), "client", "credentials.sqlite"),
        }),
      });
      clients.push(client);
      expect((await client.request<UsersSelfResult>("users.self", {})).profile.id).toBe(
        scenario.profileId,
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: scenario.sessionKey },
        {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: scenario.profileId },
        },
      );
      const turn = await client.request<{ runId: string }>(
        "agent",
        {
          sessionKey: scenario.sessionKey,
          message: scenario.prompt,
          idempotencyKey: `wake-operator-${scenario.gate}-${id}`,
          deliver: false,
        },
        { expectFinal: true },
      );
      // The turn ended holding its election as operator-owned durable work, not yet woken.
      const scheduled = await readWorkRows(scenario.sessionKey);
      const custody = retained.filter((entry) => entry.sessionKey === scenario.sessionKey);
      const pendingWakes = wakes.filter((wake) => wake.sessionKey === scenario.sessionKey).length;
      if (scenario.chained) {
        // Hop 2 has run and its turn has elected hop 3, which waits in the custody store.
        await waitFor(async () => {
          const rows = await readWorkRows(scenario.sessionKey);
          return rows[0]?.status === "succeeded" && rows[1]?.status === "queued";
        }, WAKE_TURN_BOUND_MS);
      }
      if (scenario.gate === "revoked" || scenario.gate === "chained-revoked") {
        scenario.requestsAtRevocation = scenario.requests;
        setUserProfileRole(scenario.profileId, "revoked");
      } else if (scenario.gate === "reassigned") {
        const replacement = ensureProfileForEmail(`wake-operator-replacement-${id}@example.test`);
        setUserProfileRole(replacement.id, "scoped");
        linkEmail(scenario.email, replacement.id);
      }
      const settled = async () => {
        const rows = await readWorkRows(scenario.sessionKey);
        return (
          rows.length === (scenario.chained ? 2 : 1) &&
          rows.every((row) => row.status !== "queued" && row.status !== "running") &&
          (scenario.gate !== "retained" || scenario.spawnResult !== undefined)
        );
      };
      await waitFor(settled, WAKE_TURN_BOUND_MS);
      const describeCustody = (entries: typeof retained) =>
        entries.map((entry) => {
          assertAdmittedRunOperatorAuthority(entry.authority);
          return {
            flowId: entry.flowId,
            profileId: entry.authority.profileId,
            scopes: [...entry.authority.scopes],
            agents: entry.authority.rolePolicy?.agents,
          };
        });
      results.push({
        gate: scenario.gate,
        profileId: scenario.profileId,
        scheduled,
        retainedCustody: describeCustody(custody),
        chainedCustody: describeCustody(
          retained.filter((entry) => entry.sessionKey === scenario.sessionKey),
        ),
        // Evidence only: which producer built each custody (a saved source sets no reauthorize).
        custodyProducers: retained
          .filter((entry) => entry.sessionKey === scenario.sessionKey)
          .map((entry) => {
            assertAdmittedRunOperatorAuthority(entry.authority);
            return {
              reauthorize: entry.authority.reauthorize !== undefined,
              savedSource: entry.authority.recoverySnapshot !== undefined,
            };
          }),
        wakesBeforeRevocation: pendingWakes,
        order: order.sequence(scenario.sessionKey, turn.runId),
        hopTwoTurns: scenario.hopTwoTurns,
        hopThreeTurns: scenario.hopThreeTurns,
        requestsAfterRevocation:
          scenario.requestsAtRevocation === undefined
            ? undefined
            : scenario.requests - scenario.requestsAtRevocation,
        wakes: wakes.filter((wake) => wake.sessionKey === scenario.sessionKey),
        settledRows: await readWorkRows(scenario.sessionKey),
        spawnResult: scenario.spawnResult,
      });
    }

    console.log(`[finished-child-wake:operator] ${JSON.stringify(results, null, 2)}`);
    for (const result of results) {
      const restricted = { profileId: result.profileId, scopes, agents: ["main"] };
      expect(result.scheduled).toEqual([
        expect.objectContaining({ status: "queued", operatorAuthorityRequired: true }),
      ]);
      expect(result.retainedCustody).toEqual([
        { flowId: result.scheduled[0]?.recordId, ...restricted },
      ]);
      expect(result.wakesBeforeRevocation).toBe(0);
      const hopWake = { preparedRunStarted: true, operatorAuthority: restricted };
      if (result.gate === "chained") {
        // Hop 2 armed hop 3 under the same operator, and hop 3 ran under it.
        expect(result).toMatchObject({
          order: ["run-ended", "wake-prepared", "wake-prepared"],
          hopTwoTurns: 1,
          hopThreeTurns: 1,
          wakes: [hopWake, hopWake],
        });
        expect(result.settledRows).toEqual([
          expect.objectContaining({ status: "succeeded" }),
          expect.objectContaining({ status: "succeeded", operatorAuthorityRequired: true }),
        ]);
        expect(result.chainedCustody).toEqual(
          result.settledRows.map((row) => ({ flowId: row.recordId, ...restricted })),
        );
      } else if (result.gate === "chained-revoked") {
        // Revoked after hop 2: hop 3 refuses before a turn or a notice reaches the model.
        expect(result).toMatchObject({
          order: ["run-ended", "wake-prepared"],
          hopTwoTurns: 1,
          hopThreeTurns: 0,
          requestsAfterRevocation: 0,
          wakes: [hopWake],
        });
        expect(result.settledRows).toEqual([
          expect.objectContaining({ status: "succeeded" }),
          expect.objectContaining({
            status: "failed",
            failureReason: expect.stringContaining("Retained operator authority revoked"),
            operatorAuthorityRequired: true,
          }),
        ]);
        expect(result.settledRows[1]?.terminalNoticePending).toBeUndefined();
        expect(result.chainedCustody).toEqual(
          result.settledRows.map((row) => ({ flowId: row.recordId, ...restricted })),
        );
      } else if (result.gate === "retained") {
        // The wake ran under the operator's own role, which refused the forbidden agent.
        expect(result).toMatchObject({
          order: ["run-ended", "wake-prepared"],
          hopTwoTurns: 1,
          wakes: [{ preparedRunStarted: true, operatorAuthority: restricted }],
          spawnResult: { status: "error", error: expect.stringContaining(roleError) },
        });
        expect(result.settledRows).toEqual([expect.objectContaining({ status: "succeeded" })]);
      } else {
        // Revoked custody fails the wake closed: no turn, a terminal failed row.
        expect(result).toMatchObject({ order: ["run-ended"], hopTwoTurns: 0, wakes: [] });
        expect(result.settledRows).toEqual([
          expect.objectContaining({
            status: "failed",
            failureReason: expect.stringContaining("Retained operator authority"),
          }),
        ]);
      }
    }
    expect(forbiddenRequests).toEqual([]);
  } finally {
    order.stop();
    for (const client of clients) {
      await disconnectGatewayClient(client);
    }
    await gateway.server.close({ reason: "operator wake custody proof complete" });
    await model.close();
    await state.cleanup();
  }
}, 180_000);
