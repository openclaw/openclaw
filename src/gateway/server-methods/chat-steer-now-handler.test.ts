import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  captureAgent,
  makeTool,
  user,
} from "../../../packages/agent-core/src/agent-loop.test-support.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  createReplyOperation,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { beginSessionControllerSteer } from "../../sessions/session-controller.steer.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

async function fixture(interruptible: boolean, signal: AbortSignal) {
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("write", "steer-owner");
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:steer-now",
    sessionId: "steer-now-session",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(client.authenticatedUserProfile, "profile").profileId,
    },
  });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  const entered = createDeferred<AbortSignal>();
  const released = createDeferred();
  const cleanup = createDeferred();
  const { agent, requests } = captureAgent([
    {
      ...makeTool("held_tool"),
      interruptible: interruptible ? true : undefined,
      execute: async (_id, _args, toolSignal) => {
        const current = expectDefined(toolSignal, "tool cancellation");
        current.addEventListener("abort", () => released.resolve(), { once: true });
        entered.resolve(current);
        await withinTest(released.promise, signal);
        await withinTest(cleanup.promise, signal);
        return { content: [{ type: "text", text: "settled" }], details: {} };
      },
    },
  ]);
  const run = agent.prompt("Start synthetic work.");
  const toolSignal = await withinTest(entered.promise, signal);
  const target = captureSessionTarget({
    ...scope,
    storeScope: scope.storePath,
    incarnation: scope.sessionId,
  });
  const operation = createReplyOperation({ ...scope, target, resetTriggered: false });
  operation.setPhase("running");
  const committed = createDeferred();
  const cancel = vi.fn();
  let queued: AgentMessage | undefined;
  const interruption = vi.fn(() => agent.interruptTools());
  operation.attachBackend({
    kind: "embedded",
    runId: "active-steer-run",
    cancel,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, options, assertCurrent) => {
        assertCurrent();
        queued = user(text);
        agent.steer(queued);
        options?.onQueueAccepted?.(true);
        await committed.promise;
      },
      steerNow: {
        read: () => {
          if (!agent.hasPendingSteeringMessage((message) => message === queued)) {
            return undefined;
          }
          const { blocked, interruptible: running } = agent.getToolInterruptionStatus();
          return {
            status: blocked.length ? "blocked" : "available",
            tools: (blocked.length ? blocked : running).map((tool) => tool.toolName),
          };
        },
        send: () => {
          const result = interruption();
          return { status: result.status, tools: result.tools.map((tool) => tool.toolName) };
        },
      },
    },
  });
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message === queued) {
      committed.resolve();
    }
  });
  const runId = "pending-steer";
  const receipt = expectDefined(
    await stageSessionPendingInput(scope, {
      runId,
      message: {
        role: "user",
        content: "Use the correction.",
        timestamp: 1,
        idempotencyKey: `${runId}:user`,
      },
      requestFingerprint: "c".repeat(64),
      assertCurrent() {},
    }),
    "pending receipt",
  );
  const input = reserveSessionControllerSource(scope.sessionKey, {
    target,
    protocolRunId: runId,
    policy: { mode: "steer" },
  });
  registerRpcSource(runId, { input, adapter: { kind: "chat-send" } });
  const attempt = expectDefined(
    await beginSessionControllerSteer({
      input,
      target: expectDefined(captureReplyMessageInjectionTarget(operation), "active target"),
      text: "Use the correction.",
      options: { waitForTranscriptCommit: true },
    }),
    "steering attempt",
  );
  expect(await attempt.acceptance).toBe(true);
  return {
    agent,
    requests,
    toolSignal,
    interruption,
    cancel,
    operation,
    run,
    attempt,
    client,
    context,
    scope,
    released,
    cleanup,
    page: async () => {
      const [ok, result] = await chatRpc(context, client, "chat.history", {
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
      });
      expect(ok).toBe(true);
      return (result as { pendingInputs: ChatPendingInputsPage }).pendingInputs;
    },
    send: (caller = client, params: Record<string, unknown> = {}) =>
      chatRpc(context, caller, "chat.steerNow", {
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        runId,
        ...params,
      }),
    async [Symbol.asyncDispose]() {
      released.resolve();
      cleanup.resolve();
      committed.resolve();
      await run;
      await attempt.outcome;
      operation.complete();
      retireSessionControllerInput(input);
      receipt.finish("cancelled");
      await receipt.settled?.();
      await disposeSessionReadContexts();
    },
  };
}

it("interrupts a pending steer's tools once, records the reason, injects, and continues", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await using f = await fixture(true, signal);
    expect((await f.page()).items[0]?.steerNow).toEqual({
      status: "available",
      tools: ["held_tool"],
    });
    expect(await f.send()).toEqual([true, { status: "interrupted", tools: ["held_tool"] }]);
    expect(f.toolSignal.aborted).toBe(true);
    expect(f.agent.state.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(await f.send()).toEqual([true, { status: "interrupted", tools: ["held_tool"] }]);
    expect(f.interruption).toHaveBeenCalledOnce();
    f.cleanup.resolve();
    await withinTest(f.run, signal);
    await f.attempt.outcome;
    expect(f.requests[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          isError: true,
          content: [
            { type: "text", text: "settled" },
            { type: "text", text: "Interrupted by the user to send a pending message." },
          ],
          details: { status: "interrupted", reason: "user_steer", partialResult: {} },
        }),
        expect.objectContaining({ role: "user", content: "Use the correction." }),
      ]),
    );
    expect(f.agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
    expect(f.operation.abortSignal.aborted).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(await f.send()).toEqual([true, { status: "settled", tools: [] }]);
    expect((await f.page()).items[0]?.steerNow).toBeUndefined();
  });
});

it("reports unsafe tools and rejects readers, foreign sessions, and stale session identities", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await using f = await fixture(false, signal);
    expect((await f.page()).items[0]?.steerNow).toEqual({
      status: "blocked",
      tools: ["held_tool"],
    });
    for (const role of ["view", "none"] as const) {
      expect((await f.send(roleClient(role, `steer-${role}`)))[0]).toBe(false);
    }
    const readOnly = { ...f.client, connect: { ...f.client.connect, scopes: ["operator.read"] } };
    expect(await f.send(readOnly)).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(await f.send(f.client, { sessionId: "replaced" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST" },
    ]);
    expect((await f.send(f.client, { sessionKey: "agent:main:foreign" }))[0]).toBe(false);
    expect(f.interruption).not.toHaveBeenCalled();
    expect(await f.send()).toEqual([true, { status: "blocked", tools: ["held_tool"] }]);
    const ownSessionWriter = {
      ...f.client,
      connect: {
        ...f.client.connect,
        scopes: ["operator.sessions.read", "operator.sessions.write"],
      },
    };
    expect(await f.send(ownSessionWriter)).toEqual([
      true,
      { status: "blocked", tools: ["held_tool"] },
    ]);
    const otherWriter = roleClient("write", "steer-other-writer");
    otherWriter.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    expect(await f.send(otherWriter)).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(f.toolSignal.aborted).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled();
  });
});
