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

    const result = await handleCompactCommand(
      buildLifecycleParams({ opts: { turnAdoptionLifecycle: { onAdopted } } }),
      true,
    );

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledOnce();
    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expect(result?.reply?.text).toContain("Compaction skipped");
  });

  it.each([true])("propagates adoption failure before effects, active run=%s", async (active) => {
    const error = new Error("ingress adoption lost");
    const onAdopted = vi.fn().mockRejectedValue(error);
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(active);
    if (active) {
      vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false);
    }

    await expect(
      handleCompactCommand(
        buildLifecycleParams({ opts: { turnAdoptionLifecycle: { onAdopted } } }),
        true,
      ),
    ).rejects.toBe(error);

    expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledTimes(active ? 1 : 0);
    expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
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
        handleCompactCommand(
          buildLifecycleParams({
            opts: { turnAdoptionLifecycle: { onAdopted, abortSignal: controller.signal } },
          }),
          true,
        ),
      ).rejects.toThrow("ingress stopped");

      expect(onAdopted).not.toHaveBeenCalled();
      expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
    },
  );

  it.each(["caller", "channel owner", "plugin owner"] as const)(
    "rechecks %s authority after ingress adoption",
    async (authority) => {
      const controller = new AbortController();
      let ownerCurrent = true;
      const onAdopted = async () => {
        controller.abort();
        ownerCurrent = false;
      };
      const assertOwnerCurrent = () => {
        if (!ownerCurrent) {
          throw new Error("Command owner was revoked");
        }
      };
      const params = buildLifecycleParams({
        opts: {
          abortSignal: authority === "caller" ? controller.signal : undefined,
          turnAdoptionLifecycle: { onAdopted },
        },
      });
      if (authority === "channel owner") {
        params.command.assertOwnerCurrent = assertOwnerCurrent;
      }
      const operation = handleCompactCommand(
        params,
        true,
        authority === "plugin owner" ? assertOwnerCurrent : undefined,
      );

      if (authority !== "caller") {
        await expect(operation).rejects.toThrow("Command owner was revoked");
      } else {
        expect((await operation)?.sessionCompaction?.reason).toBe("command invocation closed");
      }
      expect(waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
      expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
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
      expect(onAdopted).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
    },
  );

  it("rejects owner revocation while compaction waits for the active run to drain", async () => {
    let ownerCurrent = true;
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
      ownerCurrent = false;
      return true;
    });
    await expect(
      handleCompactCommand(
        {
          ...buildCompactParams("/compact", {}),
          sessionEntry: { sessionId: "session-1", updatedAt: 1 },
        },
        true,
        () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      ),
    ).rejects.toThrow("Command owner was revoked");
    expect(abortEmbeddedAgentRun).toHaveBeenCalledOnce();
    expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expect(incrementCompactionCount).not.toHaveBeenCalled();
  });

  it.each(["invocation", "caller", "owner", "session"] as const)(
    "rejects stale %s authority before cancelling after the natural wait",
    async (authority) => {
      const controller = new AbortController();
      const entry = { sessionId: "session-1", updatedAt: 1 };
      let ownerCurrent = true;
      vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
      vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
        if (authority === "session") {
          vi.mocked(prepareCurrentSessionEntry).mockResolvedValueOnce(undefined);
        } else if (authority === "owner") {
          ownerCurrent = false;
        } else {
          controller.abort();
        }
        return false;
      });
      const operation = handleCompactCommand(
        buildLifecycleParams({
          sessionEntry: entry,
          compactionSessionEntry: entry,
          commandInvocationSignal: authority === "invocation" ? controller.signal : undefined,
          opts: { abortSignal: authority === "caller" ? controller.signal : undefined },
        }),
        true,
        () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      );
      if (authority === "owner") {
        await expect(operation).rejects.toThrow("Command owner was revoked");
      } else {
        expect((await operation)?.sessionCompaction).toEqual({
          compacted: false,
          reason: authority === "session" ? "command session changed" : "command invocation closed",
        });
      }
      expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
      expect(incrementCompactionCount).not.toHaveBeenCalled();
    },
  );

  it("does not abort a run after the bound session changes", async () => {
    vi.mocked(prepareCurrentSessionEntry).mockResolvedValueOnce(undefined);
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);

    const result = await handleCompactCommand(buildLifecycleParams(), true);

    expect(result?.sessionCompaction).toEqual({
      compacted: false,
      reason: "command session changed",
    });
    expect(vi.mocked(abortEmbeddedAgentRun)).not.toHaveBeenCalled();
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
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
      await handleCompactCommand(buildLifecycleParams({ opts: { replyOperation } }), true);

      expect(replyOperation.phase).toBe("running");
    } finally {
      replyOperation.complete();
    }
  });

  it("does not replace an active run when abort drain times out", async () => {
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(abortEmbeddedAgentRun).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = await handleCompactCommand(buildLifecycleParams(), true);

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

  it.each([true])(
    "preserves the drained writer fence and completed count, with caller abort=%s",
    async (abortAfterCompletion) => {
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
        if (abortAfterCompletion) {
          controller.abort(new Error("caller closed"));
        }
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

      expect(result?.sessionCompaction?.compacted).toBe(!abortAfterCompletion);
      expect(incrementCompactionCount).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(abortAfterCompletion ? 0 : 1);
      expect(currentEntry.activeWriterRunId).toBe("drained-writer");
      expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("session-1", 60_000);
    },
  );

  it.each([true])(
    "uses the host-accepted successor before accounting, with owner replacement=%s",
    async (replaceBeforeAccounting) => {
      const initial = { sessionId: "native-session", updatedAt: 1, lifecycleRevision: "lifecycle" };
      let ownerCurrent = true;
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
          if (replaceBeforeAccounting) {
            currentSessionId = "replacement-session";
            return undefined;
          }
          return 1;
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
        ownerCurrent = false;
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

      const result = await handleCompactCommand(
        buildLifecycleParams({ sessionEntry: initial }),
        true,
        () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      );

      expect(result?.sessionCompaction).toMatchObject(
        replaceBeforeAccounting
          ? { compacted: false, reason: "session accounting failed" }
          : { compacted: true, tokensAfter: 321 },
      );
    },
  );
});
