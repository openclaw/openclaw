// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import {
  rpcSourceTesting,
  setRpcSourceIdentityForTest,
} from "../../sessions/session-lifecycle-admission.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import * as sessionUtils from "../session-utils.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { createActiveRun, invokeChatAbortHandler } from "./chat.abort.test-helpers.js";
import {
  abortContext,
  expectAbortFailure,
  expectCancelledSession,
  revocableAuthority,
  seedYieldedSession,
  stopSession,
} from "./sessions.abort-lifecycle.test-support.js";
import type { RespondFn } from "./types.js";

const fixture = useChatAbortRegistryFixture();
const sessionKey = "agent:main:native-stop";
const sessionId = "native-parent-session";
const runId = "native-parent-run";
const lifecycleRevision = "original-incarnation";
const target = { agentId: "main", sessionKey };
const requester = { ...target, sessionId, lifecycleRevision, requesterTurnRunId: runId };
type DescendantCancellation = NonNullable<AgentHarness["withDescendantCancellation"]>;

function installHarness(hook: DescendantCancellation) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "core",
    source: "runtime",
    harness: {
      id: "native-stop-test",
      label: "Native Stop fixture",
      supports: () => ({ supported: false }),
      runAttempt: async () => {
        throw new Error("No inference in cancellation proof");
      },
      withDescendantCancellation: hook,
    },
  });
  setActivePluginRegistry(registry);
}

afterEach(() => resetPluginRuntimeStateForTest());

async function seedYieldedParent() {
  await seedYieldedSession(fixture.stateDir, sessionKey, sessionId, runId, lifecycleRevision);
  expect(loadSessionEntry(target)?.status).toBeUndefined();
}

it.each([
  "reserved chat",
  "indexed chat",
  "indexed sessions",
  "reserved cross-session chat",
  "hidden cross-session chat",
] as const)("exact %s Stop retains the native requester's physical lifecycle", async (route) => {
  await seedYieldedParent();
  const crossSession = route.includes("cross-session");
  const requestedKey = crossSession ? "agent:main:other-conversation" : sessionKey;
  if (crossSession) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: requestedKey,
      defaultSessionId: "other-physical-session",
      lifecycleRevision: "other-lifecycle",
    });
  }
  const context = abortContext();
  const parent = createActiveRun(sessionKey, {
    runId,
    sessionId,
    agentId: "main",
    queued: route.startsWith("reserved"),
    controlUiVisible: route.startsWith("hidden") ? false : undefined,
  });
  if (!route.startsWith("reserved")) {
    rpcSourceTesting.set(runId, parent);
  }
  const cancel = vi.fn(async () => ({ killed: 1, cancelledRequesters: [requester] }));
  installHarness(async (params, run) => {
    expect(params).toMatchObject(requester);
    return run(cancel);
  });
  const respond = vi.fn<RespondFn>();
  const client = { connect: { scopes: ["operator.admin"] } };
  if (route === "indexed sessions") {
    await stopSession(sessionKey, respond, context, { runId }, client);
  } else {
    await invokeChatAbortHandler({
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: requestedKey, runId },
      respond,
      client,
    });
  }
  expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
  expect(parent.input.abortSignal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["reserved", "indexed"] as const)(
  "exact %s Stop rejects foreign and revoked requesters before native cancellation",
  async (route) => {
    await seedYieldedParent();
    const context = abortContext();
    const parent = createActiveRun(sessionKey, {
      runId,
      sessionId,
      agentId: "main",
      queued: route === "reserved",
      owner: { connId: "owner" },
    });
    if (route === "indexed") {
      rpcSourceTesting.set(runId, parent);
    }
    const client = { connId: "owner", connect: { scopes: ["operator.write"] }, invalidated: false };
    const cancel = vi.fn(async () => ({ killed: 1, cancelledRequesters: [requester] }));
    const prepare = vi.fn();
    installHarness(async (_params, run) => {
      prepare();
      client.invalidated = true;
      return run(cancel);
    });
    const foreignResponse = await invokeChatAbortHandler({
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey, runId },
      client: { connId: "foreign", connect: { scopes: ["operator.write"] } },
    });
    expectAbortFailure(foreignResponse, "unauthorized", "INVALID_REQUEST");
    expect(prepare).not.toHaveBeenCalled();
    expect(parent.input.abortSignal.aborted).toBe(false);
    await expect(
      invokeChatAbortHandler({
        handler: handleChatAbortRequest,
        context,
        request: { sessionKey, runId },
        client,
      }),
    ).rejects.toThrow("Gateway requester authority changed");
    expect(prepare).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    // Reserved sources stop before native preparation; accepted parent effects remain.
    expect(parent.input.abortSignal.aborted).toBe(route === "reserved");
  },
);

it.each(["reserved", "indexed"] as const)(
  "exact %s Stop rejects a retargeted source during lifecycle preparation",
  async (route) => {
    await seedYieldedParent();
    const context = abortContext();
    const parent = createActiveRun(sessionKey, {
      runId,
      sessionId,
      agentId: "main",
      queued: route === "reserved",
      controlUiVisible: false,
    });
    if (route === "indexed") {
      rpcSourceTesting.set(runId, parent);
    }
    const cancel = vi.fn(async () => ({ killed: 1, cancelledRequesters: [requester] }));
    installHarness((_params, run) => run(cancel));
    const read = sessionUtils.loadGatewaySessionEntryReadOnlyInWorker;
    const reader = vi
      .spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementation(async (params) => {
        const result = await read(params);
        if (params.key === sessionKey) {
          setRpcSourceIdentityForTest(parent, { sessionId: "retargeted-session" });
        }
        return result;
      });
    try {
      await expect(
        invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: "agent:main:other-conversation", runId },
          client: { connect: { scopes: ["operator.admin"] } },
        }),
      ).rejects.toThrow("Run changed before cancellation; retry Stop.");
      expect(parent.input.abortSignal.aborted).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      reader.mockRestore();
    }
  },
);

it.each([
  "cancelled",
  "natural success",
  "new run",
  "new revision",
  "failed settlement",
  "partial settlement",
  "retired owner",
] as const)(
  "registered sessions.abort preserves the %s outcome of a native-only yielded parent",
  async (race) => {
    await seedYieldedParent();
    const entered = createDeferred();
    const settled = createDeferred();
    const cancel = vi.fn(async () => {
      entered.resolve();
      await settled.promise;
      if (race === "failed settlement") {
        throw new Error("Native terminal was not confirmed");
      }
      return race === "natural success"
        ? { killed: 0, cancelledRequesters: [] }
        : {
            killed: 1,
            ...(race === "partial settlement"
              ? { errors: [new Error("Sibling cancellation failed")] }
              : {}),
            cancelledRequesters: [requester],
          };
    });
    installHarness(async (params, run) => {
      expect(params).toMatchObject({ ...target, sessionId, lifecycleRevision });
      const result = await run(cancel);
      if (race === "retired owner") {
        // Registry retirement cannot revoke cancellation that already settled.
        setActivePluginRegistry(createEmptyPluginRegistry());
      }
      return result;
    });
    const respond = vi.fn<RespondFn>();
    const stop = Promise.resolve(stopSession(sessionKey, respond));
    try {
      await awaitGateBeforeSettlement(entered.promise, stop, "Stop skipped its registered harness");
      expect(respond).not.toHaveBeenCalled();
      const before = expectDefined(loadSessionEntry(target), "yielded requester");
      if (race === "new revision") {
        await replaceSessionEntry(target, { ...before, lifecycleRevision: "replacement" });
      } else if (race === "new run" || race === "natural success") {
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            runId: race === "new run" ? "replacement-run" : runId,
            sessionId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            ts: Date.now(),
            data:
              race === "new run"
                ? { phase: "start", startedAt: Date.now() }
                : {
                    phase: "end",
                    startedAt: before.startedAt,
                    endedAt: Date.now(),
                    stopReason: "end_turn",
                  },
          },
        });
      }
      const expected = loadSessionEntry(target);
      settled.resolve();
      await stop;
      expect(cancel).toHaveBeenCalledOnce();
      const failures = ["failed settlement", "partial settlement"];
      expect(respond.mock.calls[0]?.[0]).toBe(!failures.includes(race));
      if (race === "cancelled" || race === "partial settlement" || race === "retired owner") {
        expectCancelledSession(loadSessionEntry(target), runId, { sessionId });
        expect(loadSessionEntry(target)?.lifecycleRunId).toBeUndefined();
      } else {
        expect(loadSessionEntry(target)).toEqual(expected);
      }
    } finally {
      settled.resolve();
      await stop;
    }
  },
);

it.each(["completed", "replaced", "retargeted", "queued successor"] as const)(
  "exact sessions.abort fences the %s outcome during native preparation",
  async (ending) => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      ...target,
      defaultSessionId: sessionId,
      lifecycleRevision,
    });
    const context = abortContext();
    const parent = createActiveRun(sessionKey, { runId, sessionId, agentId: "main" });
    rpcSourceTesting.set(runId, parent);
    let successor: ReturnType<typeof createActiveRun> | undefined;
    const entered = createDeferred();
    const resume = createDeferred();
    const cancel = vi.fn(async () => ({ killed: 0, cancelledRequesters: [] }));
    installHarness(async (_params, run) => {
      entered.resolve();
      await resume.promise;
      return run(cancel);
    });
    const respond = vi.fn<RespondFn>();
    const admin = { connect: { scopes: ["operator.admin"] } };
    const stop = Promise.resolve(stopSession(sessionKey, respond, context, { runId }, admin));
    void stop.catch(() => {});
    try {
      await awaitGateBeforeSettlement(entered.promise, stop, "Stop skipped native preparation");
      expect(respond).not.toHaveBeenCalled();
      if (ending === "retargeted") {
        setRpcSourceIdentityForTest(parent, { sessionId: "replacement-session" });
      } else {
        const claim = parent.input.claim;
        claim?.operation?.complete();
        if (claim) {
          releaseSessionControllerClaim(claim);
        }
        retireSessionControllerInput(parent.input);
        rpcSourceTesting.deleteExpected(runId, parent);
        await parent.input.settlement.promise;
        if (ending === "replaced" || ending === "queued successor") {
          successor = createActiveRun(sessionKey, {
            runId,
            sessionId,
            agentId: "main",
            queued: ending === "queued successor",
          });
          rpcSourceTesting.set(runId, successor);
        }
      }
      const session = loadSessionEntry(target);
      resume.resolve();
      if (ending === "completed") {
        await stop;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          { ok: true, status: "no-active-run", abortedRunId: null },
          undefined,
          undefined,
        );
      } else {
        await expect(stop).rejects.toThrow("Run changed before cancellation; retry Stop.");
        expect(respond).not.toHaveBeenCalled();
      }
      expect(parent.input.abortSignal.aborted).toBe(false);
      expect(successor?.input.abortSignal.aborted ?? false).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)).toEqual(session);
    } finally {
      resume.resolve();
      await stop.catch(() => {});
    }
  },
);

it.each(["embedded", "reserved", "indexed"] as const)(
  "stops a captured old %s run when native preparation rejects after row replacement",
  async (route) => {
    await seedYieldedParent();
    const original = expectDefined(loadSessionEntry(target), "original requester");
    const abort = vi.fn(() => clearActiveEmbeddedRun(sessionId, handle, sessionKey));
    const handle = createEmbeddedRunHandle({ runId, abort });
    const context = abortContext();
    const parent =
      route === "embedded"
        ? undefined
        : createActiveRun(sessionKey, {
            runId,
            sessionId,
            agentId: "main",
            queued: route === "reserved",
          });
    if (route === "embedded") {
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
    } else if (route === "indexed" && parent) {
      rpcSourceTesting.set(runId, parent);
    }
    await replaceSessionEntry(target, {
      ...original,
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-revision",
      lifecycleRunId: "replacement-run",
    });
    const replacement = loadSessionEntry(target);
    const prepare = vi.fn(async (params: Parameters<DescendantCancellation>[0]) => {
      expect(params).toMatchObject({ sessionId, requesterTurnRunId: runId });
      expect(params.lifecycleRevision).toBeUndefined();
      throw new Error("Original native generation is unavailable");
    });
    installHarness(prepare);
    const respond = vi.fn<RespondFn>();
    try {
      if (route === "embedded") {
        await stopSession(sessionKey, respond, context, { runId });
      } else {
        await invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey, runId },
          respond,
          client: { connect: { scopes: ["operator.admin"] } },
        });
      }
      expect(prepare).toHaveBeenCalledOnce();
      expect(
        route === "embedded" ? abort.mock.calls.length === 1 : parent?.input.abortSignal.aborted,
      ).toBe(true);
      expectAbortFailure(
        respond,
        expect.stringContaining("Original native generation is unavailable"),
      );
      expect(loadSessionEntry(target)).toEqual(replacement);
    } finally {
      clearActiveEmbeddedRun(sessionId, handle);
    }
  },
);

it.each(["declined", "revoked", "prepared"] as const)(
  "preserves the parent fence with %s native preparation",
  async (ending) => {
    await seedYieldedParent();
    const authority = revocableAuthority("Stop authority revoked");
    const cancel = vi.fn(async () => ({ killed: 0, cancelledRequesters: [] }));
    installHarness(
      ending === "prepared"
        ? (_params, run) => run(cancel)
        : async () => {
            if (ending === "revoked") {
              authority.revoke();
            }
            throw new Error("Native preparation failed");
          },
    );
    const beforeKill = vi.fn(() => false);
    const stop = abortControlledSubagents({
      cfg: getRuntimeConfig(),
      ...requester,
      beforeKill,
      assertCurrent: authority.assertCurrent,
    });
    if (ending === "revoked") {
      await expect(stop).rejects.toThrow("Stop authority revoked");
      expect(beforeKill).not.toHaveBeenCalled();
    } else {
      expect(await stop).toBeUndefined();
      expect(beforeKill).toHaveBeenCalledOnce();
    }
    expect(loadSessionEntry(target)?.status).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  },
);
