import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAgentPreacceptRefusal,
  readAgentSelfHeldRefusal,
} from "../../gateway/agent-turn/agent-admission-refusal.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { errorShapeFromError } from "../../gateway/error-shape.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { PluginInstance, type PluginReplacementOutcome } from "../../plugins/plugin-instance.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import {
  clearTestEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
} from "../embedded-agent-runner/runs.test-support.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "../prepared-model-runtime-admission.js";
import { captureRequesterOrigin } from "../requester-origin.js";
import * as sandboxRuntime from "../sandbox/runtime-status.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { isSubagentEnvelopeSession } from "../subagents/spawn/subagent-capabilities.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import * as capabilityStore from "../subagents/spawn/subagent-session-store.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { jsonResult } from "./common.js";
import {
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
  resolveGatewayToolOperatorSelection,
} from "./gateway-caller-context.js";
import * as gateway from "./in-process-gateway.js";
import * as handoff from "./session-tool-handoff.js";
import { createSelfHeldSendRetainer } from "./sessions-send-self-hold.js";
import * as delivery from "./sessions-send-tool.delivery.js";
import * as input from "./sessions-send-tool.input.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

async function refuseSelfHeldAdmission(cause: unknown) {
  const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, cause);
  expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({
    value: cause,
    enumerable: false,
  });
  const cleanupGate = createDeferred();
  const order: string[] = [];
  const cleanup = vi.fn(async () => {
    await cleanupGate.promise;
    order.push("cleanup");
  });
  // Receiver reservation only; the sender still owns its plugin hold until its turn ends.
  const releaseUnacceptedReservation = vi.fn(() => {
    order.push("release");
    return true;
  });
  const emitAcceptance = vi.fn<
    Parameters<typeof createAgentPreacceptRefusal>[0]["io"]["emitAcceptance"]
  >((frame) => {
    order.push("emission");
    expect(frame[2]).toBe(error);
    expect(readAgentSelfHeldRefusal(error)?.cause).toBe(cause);
    expect(readAgentSelfHeldRefusal(cause)?.admission).toEqual({
      acceptance: "not_accepted",
      stage: "runtime-preparation",
    });
  });
  const reject = createAgentPreacceptRefusal(
    { releaseUnacceptedReservation, io: { emitAcceptance } },
    cleanup,
  );
  const rejection = reject(error);
  try {
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(false, error.message);
    expect(releaseUnacceptedReservation).not.toHaveBeenCalled();
    expect(emitAcceptance).not.toHaveBeenCalled();
    expect(readAgentSelfHeldRefusal(cause)?.admission.acceptance).toBe("uncertain");
  } finally {
    cleanupGate.resolve();
    await rejection;
  }
  expect(order).toEqual(["cleanup", "release", "emission"]);
  expect(emitAcceptance).toHaveBeenCalledExactlyOnceWith([false, undefined, error]);
}

it.each([
  [true, false, false],
  [false, false, false],
  [false, true, false],
  [false, false, true],
] as const)(
  "classifies the real factory caller before retention (parent-owned=%s, unobserved async=%s, implicit resume=%s)",
  async (parentOwned, unobserved, implicitResume) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        tools: { sessions: { visibility: "all" } },
      };
      setRuntimeConfigSnapshot(config);
      setActivePluginRegistry(createSessionConversationTestRegistry());
      const sourceKey = "agent:main:dashboard:source";
      const targetKey = "agent:main:dashboard:target";
      const sourceId = "source-session";
      const target = { agentId: "main", sessionKey: targetKey, sessionId: "target-session" };
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "parent-session", updatedAt: 1 },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: sourceKey },
        {
          sessionId: sourceId,
          updatedAt: 1,
          ...(parentOwned
            ? { spawnedBy: "agent:main:main", parentSessionId: "parent-session" }
            : {}),
        },
      );
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        ...(implicitResume ? { spawnedBy: sourceKey, parentSessionId: sourceId } : {}),
      });
      if (implicitResume) {
        // A paused registry row is fixture input; this test does not claim a registry write.
        subagentRuns.set(
          "paused-resume",
          createSubagentRunRecord({
            runId: "paused-resume",
            requesterAgentId: "main",
            requesterStorePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            controllerStorePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            childSessionKey: targetKey,
            childSessionIdentity: { sessionId: target.sessionId },
            requesterSessionKey: sourceKey,
            requesterDisplayKey: sourceKey,
            controllerSessionKey: sourceKey,
            task: "Wait",
            cleanup: "keep",
            endedAt: Date.now(),
            pauseReason: "sessions_yield",
            expectsCompletionMessage: true,
          }),
        );
      }
      const row = loadSessionEntry({ agentId: "main", sessionKey: sourceKey });
      expect(isSubagentSessionFromEntry(sourceKey, row)).toBe(parentOwned);
      expect(isSubagentEnvelopeSession(sourceKey, { cfg: config, entry: row })).toBe(false);
      const instance = new PluginInstance("caller-held-plugin");
      const consumer = instance.retainConsumer();
      const settled = createDeferred<PluginReplacementOutcome>();
      const release = instance.reserveReplacement({
        operationId: "reload",
        settled: settled.promise,
      });
      const handle = createEmbeddedRunHandle({ runId: "source-run" });
      const operation = registerTestEmbeddedRun(sourceId, handle, sourceKey, undefined, "main");
      const onYield = vi.fn();
      let work: Parameters<typeof handoff.handoffSessionTool>[0] | undefined;
      const timeout = vi.spyOn(input, "readSessionsSendTimeout");
      const handoffs = vi
        .spyOn(handoff, "handoffSessionTool")
        .mockImplementation(async (params) => {
          work = params;
          await params.onYield?.("fixture handoff admitted");
          return jsonResult({ status: "started", async: true, message: "fixture handoff started" });
        });
      const effect = vi.fn();
      // Real factory, store, communication gate and guard; transport/handoff are fixtures.
      // Refusal runs the real factory with receiver cleanup/reservation fixture ports.
      const dispatch = vi
        .spyOn(delivery, "callSessionsSendGateway")
        .mockImplementation(async () => {
          try {
            assertPreparedModelRuntimeAdmissionCanWait();
            effect();
            return { status: "accepted", runId: "resumed", taskRunId: "paused-resume" };
          } catch (error) {
            await refuseSelfHeldAdmission(error);
            throw error;
          }
        });
      const resolve = vi.spyOn(gateway, "callAgentToolGatewayRequest").mockResolvedValue({
        key: targetKey,
        agentId: "main",
      });
      try {
        const caller = {
          agentId: "main",
          sessionKey: sourceKey,
          operationalRunInstance: createOperationalRunInstanceRef("source-run"),
          receiptAuthority: () => true,
        };
        const result = await withGatewayToolCallerIdentity(caller, () =>
          consumer.run(() =>
            runWithAgentToolExecutionContext(
              {
                assistantMessage: makeAgentAssistantMessage({
                  content: [],
                  api: "test-api",
                  provider: "test-provider",
                  stopReason: "toolUse",
                }),
                toolCall: {
                  type: "toolCall",
                  id: "original-send",
                  name: "sessions_send",
                  arguments: {},
                },
                hasUnobservedAsyncToolResults: unobserved,
              },
              () =>
                createSessionsSendTool({
                  config,
                  agentId: "main",
                  agentSessionKey: sourceKey,
                  agentSessionId: sourceId,
                  runId: "source-run",
                  onYield,
                }).execute("original-send", {
                  sessionKey: targetKey,
                  message: "original continuation",
                  ...(implicitResume ? {} : { mode: "followup", timeoutSeconds: 0 }),
                }),
            ),
          ),
        );
        expect(dispatch, JSON.stringify(result.details)).toHaveBeenCalledOnce();
        expect(result.details).toMatchObject(
          parentOwned
            ? {
                status: "error",
                selfHold: {
                  retained: false,
                  acceptance: "not_accepted",
                  why: "unsupported-caller",
                },
              }
            : { status: "started", retained: { acceptance: "not_accepted" } },
        );
        release();
        consumer.release();
        settled.resolve({ kind: "applied", committed: true, unavailablePluginIds: [] });
        clearTestEmbeddedRun(sourceId, handle, sourceKey);
        await Promise.all([settled.promise, operation.ownerSettlement]);
        expect(handoffs).toHaveBeenCalledTimes(parentOwned ? 0 : 1);
        if (!parentOwned) {
          expect(handoffs.mock.calls[0]?.[0].yield).toBe(unobserved ? "after_turn" : "conditional");
        }
        expect(onYield).toHaveBeenCalledTimes(parentOwned ? 0 : 1);
        expect(effect).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
        if (implicitResume) {
          assert(work?.run);
          const replayed = await withGatewayToolCallerIdentity(caller, () =>
            work!.run!({
              signal: new AbortController().signal,
              assertCurrent: () => {},
            }),
          );
          expect(replayed, JSON.stringify(replayed)).toMatchObject({
            outcomes: [{ status: "accepted", mode: "resume", completion: "task" }],
          });
          expect(timeout.mock.calls.at(-1)).toEqual([
            expect.objectContaining({ mode: "resume", timeoutSeconds: 0, watch: undefined }),
            "resume",
          ]);
          expect(effect).toHaveBeenCalledOnce();
          expect(dispatch).toHaveBeenCalledTimes(2);
          for (const invalid of [{ timeoutSeconds: 1 }, { watch: true }]) {
            await expect(
              withGatewayToolCallerIdentity(caller, () =>
                createSessionsSendTool({
                  config,
                  agentId: "main",
                  agentSessionKey: sourceKey,
                }).execute("invalid", {
                  sessionKey: targetKey,
                  message: "Continue",
                  mode: "resume",
                  ...invalid,
                }),
              ),
            ).rejects.toThrow("admission only");
          }
          expect(dispatch).toHaveBeenCalledTimes(2);
        }
      } finally {
        release();
        consumer.release();
        settled.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
        clearTestEmbeddedRun(sourceId, handle, sourceKey);
        await Promise.all([settled.promise, operation.ownerSettlement, instance.dispose()]);
        handoffs.mockRestore();
        dispatch.mockRestore();
        resolve.mockRestore();
        timeout.mockRestore();
        subagentRuns.delete("paused-resume");
      }
    }),
);

// Handoff/opaque replay are ports here; the guard fact, batch and policy state machine are real.
it.each([
  "uncertain",
  "policy-denied",
  "sender-denied",
  "sender-allowed",
  "sandbox-denied",
  "sandbox-enabled",
  "sandbox-enabled-allowed",
  "sandbox-preparation-native",
  "sandbox-preparation-memory",
  "sandbox-admission-native",
  "sandbox-admission-memory",
  "sandbox-effect-native",
  "sandbox-effect-memory",
  "sandbox-known-result-memory",
  "sandbox-stable-native",
  "sandbox-ceiling",
  "entered-error",
  "different-requester",
  "handoff-failure",
] as const)("settles retained send at the %s boundary without a second replay", async (boundary) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const currentness = /sandbox-(preparation|admission|effect|known-result|stable)-/.test(
      boundary,
    );
    const memory = boundary.endsWith("-memory");
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      tools: { profile: "full" },
      ...(currentness
        ? {
            agents: { ownership: "explicit", entries: { main: { sandbox: { mode: "non-main" } } } },
            tools: { profile: "full", sandbox: { tools: { deny: ["sessions_send"] } } },
          }
        : {}),
      ...(memory
        ? {
            session: {
              store: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
            },
          }
        : {}),
    };
    setRuntimeConfigSnapshot(config);
    const sessionKey = "agent:main:dashboard:retainer";
    const sessionId = "retainer-session";
    const source = { agentId: "main", sessionKey, storePath: config.session?.store };
    await replaceSessionEntry(source, {
      sessionId,
      updatedAt: 1,
      ...(currentness ? { sandboxMode: "off" as const } : {}),
      ...(memory ? { incognito: true } : {}),
    });
    const removeOptOut = async () => {
      await upsertSessionEntryCore(source, { sandboxMode: undefined });
      expect(getRuntimeConfig()).toBe(config);
      expect(loadSessionEntry(source)?.sandboxMode).toBeUndefined();
    };
    // Call-through barriers mutate the real selected source; neither returns policy facts.
    const prepare = capabilityStore.prepareSessionCapabilityRead;
    const preparation = vi
      .spyOn(capabilityStore, "prepareSessionCapabilityRead")
      .mockImplementation(async (read) => {
        if (boundary.startsWith("sandbox-preparation-")) {
          await removeOptOut();
        }
        return prepare(read);
      });
    const classify = sandboxRuntime.withSandboxRuntimeStatusInWorker;
    const classification = vi
      .spyOn(sandboxRuntime, "withSandboxRuntimeStatusInWorker")
      .mockImplementation(async (params, authority, consume) => {
        const result = await classify(params, authority, consume);
        if (boundary.startsWith("sandbox-admission-")) {
          await removeOptOut();
        }
        return result;
      });
    const handle = createEmbeddedRunHandle({ runId: "retainer-run" });
    const operation = registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
    const instance = new PluginInstance("retainer-plugin");
    const consumer = instance.retainConsumer();
    const settled = createDeferred<PluginReplacementOutcome>();
    const release = instance.reserveReplacement({
      operationId: "retainer-reload",
      settled: settled.promise,
    });
    let work: Parameters<typeof handoff.handoffSessionTool>[0] | undefined;
    const handoffs = vi.spyOn(handoff, "handoffSessionTool").mockImplementation(async (params) => {
      if (boundary === "handoff-failure" && handoffs.mock.calls.length === 1) {
        throw new Error("handoff refused");
      }
      work = params;
      return jsonResult({ status: "started", async: true, message: "fixture handoff started" });
    });
    const effect = vi.fn();
    const replay = vi.fn<Parameters<typeof createSelfHeldSendRetainer>[1]>(async (options) => {
      if (boundary.startsWith("sandbox-effect-")) {
        await removeOptOut();
      }
      options.assertSourceCurrent?.();
      effect();
      if (boundary === "sandbox-known-result-memory") {
        await removeOptOut();
      }
      if (currentness) {
        return jsonResult({ status: "accepted", runId: "original-send" });
      }
      throw new Error("executor entered");
    });
    const onYield = vi.fn();
    try {
      let caught: unknown;
      consumer.run(() => {
        try {
          assertPreparedModelRuntimeAdmissionCanWait();
        } catch (error) {
          caught = error;
        }
      });
      assert(caught);
      if (boundary !== "uncertain") {
        await refuseSelfHeldAdmission(caught);
      }
      const proof = readAgentSelfHeldRefusal(caught);
      assert(proof);
      const retain = createSelfHeldSendRetainer(
        {
          agentId: "main",
          agentSessionKey: sessionKey,
          agentSessionId: sessionId,
          runId: "retainer-run",
          sandboxed: boundary === "sandbox-denied" || boundary === "sandbox-ceiling",
          onYield,
        },
        replay,
      );
      const send = {
        runId: "original-send",
        mode: "followup" as const,
        args: { message: "original" },
        sessionKey: "agent:main:target",
        targetAgentId: "main",
        sessionId: "target-id",
        storePath: "/fixture/store",
        targetRun: null,
        requesterParentOwned: false,
      };
      const call = (origin: string) =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            requesterOrigin: {
              sessionKey,
              messageProvider: origin,
              senderId: "alice",
              chatType: "direct",
            },
          },
          () => retain(proof, send, "call"),
        );
      const result = await call("original");
      if (boundary === "uncertain") {
        expect(result.details).toMatchObject({
          status: "error",
          selfHold: { acceptance: "uncertain", why: "uncertain" },
        });
        expect(handoffs).not.toHaveBeenCalled();
        expect(onYield).not.toHaveBeenCalled();
        expect(replay).not.toHaveBeenCalled();
        return;
      }
      if (boundary === "handoff-failure") {
        expect(result.details).toMatchObject({ selfHold: { why: "handoff-unavailable" } });
        expect((await call("original")).details).toMatchObject({ status: "started" });
        expect(handoffs).toHaveBeenCalledTimes(2);
      } else {
        expect(result.details).toMatchObject({ status: "started" });
      }
      if (boundary === "different-requester") {
        expect((await call("other")).details).toMatchObject({
          selfHold: { why: "different-requester" },
        });
        expect(handoffs).toHaveBeenCalledOnce();
      }
      release();
      consumer.release();
      settled.resolve({ kind: "applied", committed: true, unavailablePluginIds: [] });
      clearTestEmbeddedRun(sessionId, handle, sessionKey);
      await operation.ownerSettlement;
      if (boundary === "policy-denied") {
        setRuntimeConfigSnapshot({ tools: { deny: ["sessions_send"] } });
      }
      if (boundary === "sender-denied" || boundary === "sender-allowed") {
        setRuntimeConfigSnapshot({
          tools: {
            profile: "full",
            toolsBySender: {
              "id:alice": { deny: boundary === "sender-denied" ? ["sessions_send"] : ["exec"] },
            },
          },
        });
      }
      if (
        [
          "sandbox-denied",
          "sandbox-enabled",
          "sandbox-enabled-allowed",
          "sandbox-ceiling",
        ].includes(boundary)
      ) {
        setRuntimeConfigSnapshot({
          agents: {
            ownership: "explicit",
            entries: {
              main: {
                sandbox: { mode: boundary.startsWith("sandbox-enabled") ? "non-main" : "off" },
              },
            },
          },
          tools: {
            profile: "full",
            sandbox: {
              tools: {
                allow: ["sessions_send"],
                deny:
                  boundary === "sandbox-ceiling" || boundary === "sandbox-enabled-allowed"
                    ? ["exec"]
                    : ["sessions_send"],
              },
            },
          },
        });
      }
      const changedInsideExecutor = boundary.startsWith("sandbox-effect-");
      const changedBeforeEffect =
        boundary.startsWith("sandbox-preparation-") || boundary.startsWith("sandbox-admission-");
      const denied =
        changedBeforeEffect ||
        ["policy-denied", "sender-denied", "sandbox-denied", "sandbox-enabled"].includes(boundary);
      assert(work?.run);
      const scope = { signal: new AbortController().signal, assertCurrent: () => {} };
      const replayResult = await work.run(scope);
      expect(replayResult, JSON.stringify(replayResult)).toMatchObject({
        outcomes: [
          {
            runId: "original-send",
            status: denied
              ? "not_delivered"
              : changedInsideExecutor
                ? "uncertain"
                : currentness
                  ? "accepted"
                  : "uncertain",
            ...(currentness
              ? {}
              : {
                  error: denied
                    ? "Current tool policy no longer permits sessions_send."
                    : "executor entered",
                }),
          },
        ],
      });
      if (changedBeforeEffect || changedInsideExecutor) {
        expect(replayResult).toMatchObject({
          outcomes: [
            {
              error: expect.stringMatching(
                /Sandbox policy changed|Session entry changed during read/,
              ),
            },
          ],
        });
      }
      expect(effect).toHaveBeenCalledTimes(denied || changedInsideExecutor ? 0 : 1);
      expect(replay).toHaveBeenCalledTimes(denied ? 0 : 1);
      if (boundary === "sandbox-ceiling" || boundary === "sandbox-enabled-allowed") {
        expect(replay.mock.calls[0]?.[0].sandboxed).toBe(true);
      }
      expect(await work.run(scope)).toEqual({ outcomes: [] });
      expect(replay).toHaveBeenCalledTimes(denied ? 0 : 1);
    } finally {
      release();
      consumer.release();
      settled.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
      clearTestEmbeddedRun(sessionId, handle, sessionKey);
      await Promise.all([operation.ownerSettlement, instance.dispose(), settled.promise]);
      handoffs.mockRestore();
      preparation.mockRestore();
      classification.mockRestore();
      if (memory) {
        memorySessionActorOwners.reset();
      }
    }
  }),
);

it.each([false, true])(
  "batches only the same selected participant (select Bob=%s)",
  async (selectBob) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot({
        agents: { ownership: "explicit", entries: { main: {} } },
        tools: { profile: "full" },
      });
      const context = createContext();
      context.resolveGatewayContext = () => context;
      const sessionKey = "agent:main:dashboard:participant-batch";
      const sessionId = "participant-batch";
      await replaceSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      const people = await Promise.all(
        ["alice", "bob"].map(async (name) => {
          const client = createOperatorClient({
            profileName: name,
            scopes: ["operator.read", "operator.write"],
          });
          const device = captureGatewayDeviceRevocation(
            context,
            { deviceId: name, role: "operator" },
            () => true,
            undefined,
            { isCurrent: () => true, subscribe: () => () => {} },
          );
          const source = await captureGatewayOperatorRunAuthority({
            client,
            context,
            hasCurrentClientAuthority: device.isCurrent,
          });
          assert(source);
          const origin = captureRequesterOrigin({
            sessionKey,
            operatorProfileId: source.authority.profileId,
          });
          return { source, device, origin };
        }),
      );
      const [alice, bob] = people;
      assert(alice && bob);
      const participants = createReplyTurnParticipants({
        operatorAuthority: alice.source.authority,
        requesterOrigin: alice.origin,
      });
      participants.accept({ operatorAuthority: bob.source.authority, requesterOrigin: bob.origin });
      const handle = createEmbeddedRunHandle({ runId: "participant-run" });
      const operation = registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
      const instance = new PluginInstance("participant-plugin");
      const consumer = instance.retainConsumer();
      const settled = createDeferred<PluginReplacementOutcome>();
      const release = instance.reserveReplacement({
        operationId: "participant-reload",
        settled: settled.promise,
      });
      let work: Parameters<typeof handoff.handoffSessionTool>[0] | undefined;
      let selected: ReturnType<typeof resolveGatewayToolOperatorSelection> | undefined;
      const handoffs = vi
        .spyOn(handoff, "handoffSessionTool")
        .mockImplementation(async (params) => {
          work = params;
          selected = resolveGatewayToolOperatorSelection();
          return jsonResult({ status: "started", async: true, message: "fixture handoff started" });
        });
      const replay = vi.fn<Parameters<typeof createSelfHeldSendRetainer>[1]>(
        async (_options, args) => jsonResult({ status: "ok", message: args.message }),
      );
      try {
        let cause: unknown;
        consumer.run(() => {
          try {
            assertPreparedModelRuntimeAdmissionCanWait();
          } catch (error) {
            cause = error;
          }
        });
        await refuseSelfHeldAdmission(cause);
        const proof = readAgentSelfHeldRefusal(cause);
        assert(proof);
        const retain = createSelfHeldSendRetainer(
          {
            agentId: "main",
            agentSessionKey: sessionKey,
            agentSessionId: sessionId,
            runId: "participant-run",
            onYield: vi.fn(),
          },
          replay,
        );
        const call = (user: string, id: string) =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey,
              requesterOrigin: alice.origin,
              operatorAuthority: alice.source.authority,
              personalToolParticipants: participants,
            },
            () =>
              withGatewayPersonalToolUser(user, () =>
                retain(
                  proof,
                  {
                    runId: id,
                    mode: "followup",
                    args: { message: id },
                    sessionKey: "agent:main:target",
                    targetAgentId: "main",
                    sessionId: "target",
                    storePath: "/fixture/store",
                    targetRun: null,
                    requesterParentOwned: false,
                  },
                  id,
                ),
              ),
          );
        expect((await call(alice.source.authority.profileId, "first")).details).toMatchObject({
          status: "started",
        });
        expect(
          (
            await call(
              selectBob ? bob.source.authority.profileId : alice.source.authority.profileId,
              "second",
            )
          ).details,
        ).toMatchObject(
          selectBob
            ? { selfHold: { retained: false, why: "different-requester" } }
            : { status: "started" },
        );
        expect(handoffs).toHaveBeenCalledOnce();
        invalidateGatewayDeviceRevocation(context, "bob", "operator");
        expect(() => bob.source.authority.assertCurrent()).toThrow();
        expect(() => alice.source.authority.assertCurrent()).not.toThrow();
        release();
        consumer.release();
        settled.resolve({ kind: "applied", committed: true, unavailablePluginIds: [] });
        assert(work?.run && selected);
        // Handoff is a port here, not a full Gateway authorization proof. Its captured
        // participant source is real and still fences the actual retainer replay.
        const replayResult = await work.run({
          signal: new AbortController().signal,
          assertCurrent: selected.assertCurrent,
        });
        expect(replayResult, JSON.stringify(replayResult)).toMatchObject({
          outcomes: expect.arrayContaining([{ status: "ok", message: "first" }]),
        });
        expect(replay.mock.calls.map(([, args]) => args.message)).toEqual(
          selectBob ? ["first"] : ["first", "second"],
        );
      } finally {
        release();
        consumer.release();
        settled.resolve({ kind: "failed", committed: false, unavailablePluginIds: [] });
        clearTestEmbeddedRun(sessionId, handle, sessionKey);
        await Promise.all([operation.ownerSettlement, instance.dispose()]);
        handoffs.mockRestore();
        participants.close();
        for (const person of people) {
          person.source.release();
          person.device.release();
        }
      }
    }),
);
