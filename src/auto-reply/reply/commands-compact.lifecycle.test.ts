// Tests compact-command session authority across awaited lifecycle transitions.
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

function buildLifecycleParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    ...buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    }),
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now() },
    ...overrides,
  };
}

function runCompact(
  overrides: Partial<HandleCommandsParams> = {},
  assertOwnerCurrent?: () => void,
) {
  return handleCompactCommand(buildLifecycleParams(overrides), true, assertOwnerCurrent);
}

function expectNotCalled(...effects: unknown[]) {
  for (const effect of effects) {
    expect(effect).not.toHaveBeenCalled();
  }
}

function ownerGuard() {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    assertCurrent: () => {
      if (!current) {
        throw new Error("Command owner was revoked");
      }
    },
  };
}

describe("handleCompactCommand lifecycle authority", () => {
  beforeEach(resetCompactCommandMocks);

  it("keeps the natural drain retryable and adopts ingress before compacting", async () => {
    let adopted = false;
    const onAdopted = vi.fn(async () => {
      adopted = true;
    });
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
      expect(adopted).toBe(false);
      return true;
    });
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
      expect(adopted).toBe(true);
      return { ok: true, compacted: false };
    });

    const result = await runCompact({ opts: { turnAdoptionLifecycle: { onAdopted } } });

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledOnce();
    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expect(result?.reply?.text).toContain("Compaction skipped");
  });

  it("propagates adoption failure before effects with an active run", async () => {
    const error = new Error("ingress adoption lost");
    const onAdopted = vi.fn().mockRejectedValue(error);
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false);

    await expect(runCompact({ opts: { turnAdoptionLifecycle: { onAdopted } } })).rejects.toBe(
      error,
    );

    expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledOnce();
    expectNotCalled(abortEmbeddedAgentRun, compactEmbeddedAgentSession);
  });

  it.each([false, true])(
    "does not adopt cancelled ingress after preflight, active run=%s",
    async (active) => {
      const controller = new AbortController();
      const onAdopted = vi.fn();
      vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(active);
      if (active) {
        vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false);
      }
      vi.mocked(prepareCurrentSessionEntry).mockImplementationOnce(async ({ expected }) => {
        controller.abort(new Error("ingress stopped"));
        return { entry: { updatedAt: 1, ...expected }, assertCurrent() {}, release() {} };
      });

      await expect(
        runCompact({
          opts: { turnAdoptionLifecycle: { onAdopted, abortSignal: controller.signal } },
        }),
      ).rejects.toThrow("ingress stopped");

      expectNotCalled(onAdopted, abortEmbeddedAgentRun, compactEmbeddedAgentSession);
    },
  );

  it.each(["caller", "channel owner", "plugin owner"] as const)(
    "rechecks %s authority after ingress adoption",
    async (authority) => {
      const controller = new AbortController();
      const owner = ownerGuard();
      const onAdopted = async () => {
        controller.abort();
        owner.revoke();
      };
      const params = buildLifecycleParams({
        opts: {
          abortSignal: authority === "caller" ? controller.signal : undefined,
          turnAdoptionLifecycle: { onAdopted },
        },
      });
      if (authority === "channel owner") {
        params.command.assertOwnerCurrent = owner.assertCurrent;
      }
      const operation = handleCompactCommand(
        params,
        true,
        authority === "plugin owner" ? owner.assertCurrent : undefined,
      );

      if (authority !== "caller") {
        await expect(operation).rejects.toThrow("Command owner was revoked");
      } else {
        expect((await operation)?.sessionCompaction?.reason).toBe("command invocation closed");
      }
      expectNotCalled(
        waitForEmbeddedAgentRunEnd,
        abortEmbeddedAgentRun,
        compactEmbeddedAgentSession,
      );
    },
  );

  it.each(["missing-session", "aborted"] as const)(
    "does not adopt ingress for a %s command",
    async (refusal) => {
      const onAdopted = vi.fn();
      const params = buildLifecycleParams({
        opts: {
          turnAdoptionLifecycle: { onAdopted },
          abortSignal: refusal === "aborted" ? AbortSignal.abort() : undefined,
        },
      });
      if (refusal === "missing-session") {
        params.sessionEntry = undefined;
      }

      expect((await handleCompactCommand(params, true))?.shouldContinue).toBe(false);
      expectNotCalled(onAdopted, compactEmbeddedAgentSession);
    },
  );

  it("rejects owner revocation while compaction waits for the active run to drain", async () => {
    const owner = ownerGuard();
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
      owner.revoke();
      return true;
    });
    await expect(
      handleCompactCommand(
        {
          ...buildCompactParams("/compact", {}),
          sessionEntry: { sessionId: "session-1", updatedAt: 1 },
        },
        true,
        owner.assertCurrent,
      ),
    ).rejects.toThrow("Command owner was revoked");
    expect(abortEmbeddedAgentRun).toHaveBeenCalledOnce();
    expectNotCalled(compactEmbeddedAgentSession, incrementCompactionCount);
  });

  it.each(["invocation", "caller", "owner", "session"] as const)(
    "rejects stale %s authority before cancelling after the natural wait",
    async (authority) => {
      const controller = new AbortController();
      const entry = { sessionId: "session-1", updatedAt: 1 };
      const owner = ownerGuard();
      vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
      vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
        if (authority === "session") {
          vi.mocked(prepareCurrentSessionEntry).mockResolvedValueOnce(undefined);
        } else if (authority === "owner") {
          owner.revoke();
        } else {
          controller.abort();
        }
        return false;
      });
      const operation = runCompact(
        {
          sessionEntry: entry,
          compactionSessionEntry: entry,
          commandInvocationSignal: authority === "invocation" ? controller.signal : undefined,
          opts: { abortSignal: authority === "caller" ? controller.signal : undefined },
        },
        owner.assertCurrent,
      );
      if (authority === "owner") {
        await expect(operation).rejects.toThrow("Command owner was revoked");
      } else {
        expect((await operation)?.sessionCompaction).toEqual({
          compacted: false,
          reason: authority === "session" ? "command session changed" : "command invocation closed",
        });
      }
      expectNotCalled(abortEmbeddedAgentRun, compactEmbeddedAgentSession, incrementCompactionCount);
    },
  );

  it("does not abort a run after the bound session changes", async () => {
    vi.mocked(prepareCurrentSessionEntry).mockResolvedValueOnce(undefined);
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);

    const result = await runCompact();

    expect(result?.sessionCompaction).toEqual({
      compacted: false,
      reason: "command session changed",
    });
    expectNotCalled(abortEmbeddedAgentRun, compactEmbeddedAgentSession);
  });

  it("marks manual compaction as maintenance until the command finishes", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:telegram:slash:test",
      sessionId: "command-operation",
      resetTriggered: false,
    });
    replyOperation.setPhase("running");
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
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
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(abortEmbeddedAgentRun).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await runCompact();

    expect(result).toEqual({
      shouldContinue: false,
      sessionCompaction: {
        compacted: false,
        reason: "the previous run is still stopping",
      },
      reply: {
        text: "⚙️ Compaction unavailable: the previous run is still stopping.\n⚠️ Your in-flight request was aborted by compaction — please resend it.",
        isStatusNotice: true,
      },
    });
    expect(vi.mocked(abortEmbeddedAgentRun)).toHaveBeenCalledWith("session-1");
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).toHaveBeenCalledWith("session-1", 15_000);
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("preserves the drained writer fence and completed count after caller abort", async () => {
    const controller = new AbortController();
    const original = {
      sessionId: "session-1",
      updatedAt: 1,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "earlier-writer",
    };
    let currentEntry = original;
    vi.mocked(prepareCurrentSessionEntry).mockImplementation(async ({ expected }) =>
      expected.sessionId === currentEntry.sessionId
        ? { entry: currentEntry, assertCurrent() {}, release() {} }
        : undefined,
    );
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
      currentEntry = { ...original, activeWriterRunId: "drained-writer" };
      return true;
    });
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (input, host) => {
      expect(input.sessionEntry).toMatchObject({ activeWriterRunId: "drained-writer" });
      host?.assertActive?.();
      controller.abort(new Error("caller closed"));
      return { ok: true, compacted: true, compactionKind: "native-harness" };
    });
    vi.mocked(incrementCompactionCount).mockImplementationOnce(async ({ expectedSession }) => {
      expect(expectedSession).toMatchObject({
        sessionId: "session-1",
        activeWriterRunId: "drained-writer",
      });
      return 1;
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {}),
        sessionEntry: original,
        opts: { abortSignal: controller.signal },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.sessionCompaction?.compacted).toBe(false);
    expect(incrementCompactionCount).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(currentEntry.activeWriterRunId).toBe("drained-writer");
    expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("session-1", 60_000);
  });

  it("uses the host-accepted successor before accounting when the owner is replaced", async () => {
    const initial = { sessionId: "native-session", updatedAt: 1, lifecycleRevision: "lifecycle" };
    const owner = ownerGuard();
    let currentSessionId = initial.sessionId;
    vi.mocked(prepareCurrentSessionEntry).mockImplementation(async ({ expected }) =>
      expected.sessionId === currentSessionId
        ? { entry: { updatedAt: 1, ...expected }, assertCurrent() {}, release() {} }
        : undefined,
    );
    vi.mocked(incrementCompactionCount).mockImplementationOnce(
      async ({ expectedSession, transcriptByteCompactionLatch }) => {
        expect(expectedSession?.sessionId).toBe("successor-session");
        expect(transcriptByteCompactionLatch).toBeNull();
        currentSessionId = "replacement-session";
        return undefined;
      },
    );
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (params, host) => {
      host?.assertActive?.();
      const storePath = params.sessionTarget?.storePath;
      if (!storePath) {
        throw new Error("expected manual compaction store");
      }
      currentSessionId = "successor-session";
      host?.onCommitted?.({
        sessionId: currentSessionId,
        sessionFile: params.sessionFile,
        sessionTarget: {
          agentId: "main",
          sessionId: currentSessionId,
          sessionKey: "agent:main:main",
          storePath,
        },
        entry: { ...initial, sessionId: currentSessionId },
        previousSessionId: initial.sessionId,
      });
      owner.revoke();
      host?.assertActive?.();
      return {
        ok: true,
        compacted: true,
        compactionKind: "context-engine",
        result: {
          summary: "compacted",
          firstKeptEntryId: "first-kept",
          sessionId: currentSessionId,
          tokensBefore: 999,
          tokensAfter: 321,
        },
      };
    });

    const result = await runCompact({ sessionEntry: initial }, owner.assertCurrent);

    expect(result?.sessionCompaction).toMatchObject({
      compacted: false,
      reason: "session accounting failed",
    });
  });
});
