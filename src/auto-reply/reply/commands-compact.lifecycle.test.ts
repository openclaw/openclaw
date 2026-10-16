import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedAgentRun,
  buildCompactParams,
  compactEmbeddedAgentSession,
  enqueueSystemEvent,
  handleCompactCommand,
  incrementCompactionCount,
  prepareCurrentSessionEntry,
  isEmbeddedAgentRunAbortableForCompaction,
  resetCompactCommandMocks,
  waitForEmbeddedAgentRunEnd,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { createReplyOperation } from "./reply-run-registry.js";

const abortRun = vi.mocked(abortEmbeddedAgentRun);
const compact = vi.mocked(compactEmbeddedAgentSession);
const prepare = vi.mocked(prepareCurrentSessionEntry);
const isAbortable = vi.mocked(isEmbeddedAgentRunAbortableForCompaction);
const waitForRun = vi.mocked(waitForEmbeddedAgentRunEnd);
const incrementCount = vi.mocked(incrementCompactionCount);
type CommandOverrides = Partial<HandleCommandsParams>;
type SessionEntry = NonNullable<HandleCommandsParams["sessionEntry"]>;

function buildLifecycleParams(overrides: CommandOverrides = {}): HandleCommandsParams {
  return {
    ...buildCompactParams("/compact", {}),
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now() },
    ...overrides,
  };
}

function runCompact(overrides: CommandOverrides = {}, assertOwnerCurrent?: () => void) {
  return handleCompactCommand(buildLifecycleParams(overrides), true, assertOwnerCurrent);
}

function expectNotCalled(...effects: unknown[]) {
  for (const effect of effects) {
    expect(effect).not.toHaveBeenCalled();
  }
}

function activeRun(...waits: Array<boolean | (() => Promise<boolean>)>) {
  isAbortable.mockReturnValueOnce(true);
  for (const wait of waits.length ? waits : [false]) {
    waitForRun.mockImplementationOnce(async () => (typeof wait === "function" ? wait() : wait));
  }
}

function sessionCustody(initial: SessionEntry) {
  const custody = { entry: initial };
  prepare.mockImplementation(async ({ expected }) =>
    expected.sessionId === custody.entry.sessionId
      ? { entry: custody.entry, assertCurrent() {}, release() {} }
      : undefined,
  );
  return custody;
}

type Authority = "invocation" | "caller" | "owner" | "channel owner" | "plugin owner" | "session";

function authorityFixture(authority: Authority) {
  const controller = new AbortController();
  const assertCurrent = () => controller.signal.throwIfAborted();
  const params = buildLifecycleParams({
    commandInvocationSignal: authority === "invocation" ? controller.signal : undefined,
    opts: { abortSignal: authority === "caller" ? controller.signal : undefined },
  });
  params.compactionSessionEntry = params.sessionEntry;
  if (authority === "channel owner") {
    params.command.assertOwnerCurrent = assertCurrent;
  }
  const pluginOwner = authority === "owner" || authority === "plugin owner";
  return {
    params,
    revoke() {
      if (authority === "session") {
        prepare.mockResolvedValueOnce(undefined);
      } else {
        controller.abort(new Error("Command owner was revoked"));
      }
    },
    run: () => handleCompactCommand(params, true, pluginOwner ? assertCurrent : undefined),
  };
}

describe("handleCompactCommand lifecycle authority", () => {
  beforeEach(resetCompactCommandMocks);

  it("keeps the natural drain retryable and adopts ingress before compacting", async () => {
    const onAdopted = vi.fn(async () => {});
    activeRun(async () => {
      expectNotCalled(onAdopted);
      return true;
    });
    compact.mockImplementationOnce(async () => {
      expect(onAdopted).toHaveBeenCalledOnce();
      return { ok: true, compacted: false };
    });

    const result = await runCompact({ opts: { turnAdoptionLifecycle: { onAdopted } } });

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledOnce();
    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expect(result?.reply?.text).toContain("Compaction skipped");
  });

  it.each([
    ["adoption failure", true],
    ["cancelled preflight", false],
    ["cancelled preflight", true],
    ["missing-session", false],
    ["aborted", false],
  ] as const)("refuses ingress at %s, active run=%s", async (stage, active) => {
    const controller = new AbortController();
    const error = new Error(
      stage === "adoption failure" ? "ingress adoption lost" : "ingress stopped",
    );
    const onAdopted = vi.fn();
    const params = buildLifecycleParams({
      opts: {
        turnAdoptionLifecycle: { onAdopted, abortSignal: controller.signal },
        abortSignal: stage === "aborted" ? AbortSignal.abort() : undefined,
      },
    });
    if (active) {
      activeRun();
    } else if (stage === "cancelled preflight") {
      isAbortable.mockReturnValueOnce(false);
    }
    if (stage === "adoption failure") {
      onAdopted.mockRejectedValue(error);
    } else if (stage === "cancelled preflight") {
      prepare.mockImplementationOnce(async ({ expected }) => {
        controller.abort(error);
        return { entry: { updatedAt: 1, ...expected }, assertCurrent() {}, release() {} };
      });
    } else if (stage === "missing-session") {
      params.sessionEntry = undefined;
    }
    const operation = handleCompactCommand(params, true);
    if (stage === "adoption failure" || stage === "cancelled preflight") {
      await expect(operation).rejects.toBe(error);
    } else {
      expect((await operation)?.shouldContinue).toBe(false);
    }
    if (stage === "adoption failure") {
      expect(waitForRun).toHaveBeenCalledOnce();
    } else {
      expectNotCalled(onAdopted);
    }
    expectNotCalled(compact, abortRun);
  });

  it.each([
    ["adoption", "caller"],
    ["adoption", "channel owner"],
    ["adoption", "plugin owner"],
    ["natural wait", "invocation"],
    ["natural wait", "caller"],
    ["natural wait", "owner"],
    ["natural wait", "session"],
    ["settled wait", "session"],
    ["abort drain", "owner"],
  ] as const)("rechecks authority after %s for %s", async (phase, authority) => {
    const fixture = authorityFixture(authority);
    const revoke = async () => {
      fixture.revoke();
      return phase === "abort drain";
    };
    if (phase === "adoption") {
      fixture.params.opts = {
        ...fixture.params.opts,
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            fixture.revoke();
          },
        },
      };
    } else if (phase === "settled wait") {
      fixture.revoke();
      activeRun(true);
    } else {
      activeRun(...(phase === "abort drain" ? [false, revoke] : [revoke]));
    }
    const operation = fixture.run();
    if (authority.includes("owner")) {
      await expect(operation).rejects.toThrow("Command owner was revoked");
    } else {
      expect((await operation)?.sessionCompaction).toEqual({
        compacted: false,
        reason: authority === "session" ? "command session changed" : "command invocation closed",
      });
    }
    expectNotCalled(compact, phase === "adoption" ? waitForRun : incrementCount);
    expect(abortRun).toHaveBeenCalledTimes(phase === "abort drain" ? 1 : 0);
  });

  it("marks manual compaction as maintenance until the command finishes", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:telegram:slash:test",
      sessionId: "command-operation",
      resetTriggered: false,
    });
    replyOperation.setPhase("running");
    compact.mockImplementationOnce(async () => {
      expect(replyOperation.phase).toBe("preflight_compacting");
      return { ok: true, compacted: false };
    });

    try {
      await runCompact({ opts: { replyOperation } });

      expect(replyOperation.phase).toBe("running");
    } finally {
      replyOperation.complete();
    }
  });

  it("does not replace an active run when abort drain times out", async () => {
    activeRun(false, false);
    abortRun.mockReturnValueOnce(true);

    const result = await runCompact();

    expect(result).toEqual({
      shouldContinue: false,
      sessionCompaction: { compacted: false, reason: "the previous run is still stopping" },
      reply: {
        text: "⚙️ Compaction unavailable: the previous run is still stopping.\n⚠️ Your in-flight request was aborted by compaction — please resend it.",
        isStatusNotice: true,
      },
    });
    expect(abortRun).toHaveBeenCalledWith("session-1");
    expect(waitForRun).toHaveBeenCalledWith("session-1", 15_000);
    expectNotCalled(compact);
  });

  it("preserves the drained writer fence and completed count after caller abort", async () => {
    const controller = new AbortController();
    const original = {
      sessionId: "session-1",
      updatedAt: 1,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "earlier-writer",
    };
    const custody = sessionCustody(original);
    activeRun(async () => {
      custody.entry = { ...original, activeWriterRunId: "drained-writer" };
      return true;
    });
    compact.mockImplementationOnce(async (input, host) => {
      expect(input.sessionEntry).toMatchObject({ activeWriterRunId: "drained-writer" });
      host?.assertActive?.();
      controller.abort(new Error("caller closed"));
      return { ok: true, compacted: true, compactionKind: "native-harness" };
    });
    incrementCount.mockImplementationOnce(async ({ expectedSession }) => {
      expect(expectedSession).toMatchObject({
        sessionId: "session-1",
        activeWriterRunId: "drained-writer",
      });
      return 1;
    });

    const result = await runCompact({
      sessionEntry: original,
      opts: { abortSignal: controller.signal },
    });

    expect(result?.sessionCompaction?.compacted).toBe(false);
    expect(incrementCount).toHaveBeenCalledOnce();
    expectNotCalled(enqueueSystemEvent, abortRun);
    expect(custody.entry.activeWriterRunId).toBe("drained-writer");
    expect(waitForRun).toHaveBeenCalledWith("session-1", 60_000);
  });

  it("uses the host-accepted successor before accounting when the owner is replaced", async () => {
    const initial = { sessionId: "native-session", updatedAt: 1, lifecycleRevision: "lifecycle" };
    const owner = new AbortController();
    const custody = sessionCustody(initial);
    incrementCount.mockImplementationOnce(
      async ({ expectedSession, transcriptByteCompactionLatch }) => {
        expect(expectedSession?.sessionId).toBe("successor-session");
        expect(transcriptByteCompactionLatch).toBeNull();
        custody.entry = { ...initial, sessionId: "replacement-session" };
        return undefined;
      },
    );
    compact.mockImplementationOnce(async (params, host) => {
      host?.assertActive?.();
      const sessionTarget = params.sessionTarget;
      if (!sessionTarget?.storePath) {
        throw new Error("expected manual compaction store");
      }
      custody.entry = { ...initial, sessionId: "successor-session" };
      host?.onCommitted?.({
        sessionId: custody.entry.sessionId,
        sessionFile: params.sessionFile,
        sessionTarget: { ...sessionTarget, sessionId: custody.entry.sessionId },
        entry: custody.entry,
        previousSessionId: initial.sessionId,
      });
      owner.abort(new Error("Command owner was revoked"));
      host?.assertActive?.();
      return { ok: true, compacted: true, compactionKind: "context-engine" };
    });

    const result = await runCompact({ sessionEntry: initial }, () => owner.signal.throwIfAborted());

    expect(result?.sessionCompaction).toMatchObject({
      compacted: false,
      reason: "session accounting failed",
    });
  });
});
