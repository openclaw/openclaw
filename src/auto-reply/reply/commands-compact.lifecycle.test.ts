// Tests compact-command authority and settlement through the real session controller.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import {
  buildCompactParams,
  compactEmbeddedAgentSession,
  enqueueSystemEvent,
  handleCompactCommand,
  incrementCompactionCount,
  prepareCurrentSessionEntry,
  resetCompactCommandMocks,
  startCompactActiveRun,
  waitForSessionControllerSettlement,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

function buildLifecycleParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    ...buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    }),
    sessionEntry: { sessionId: "session-1", updatedAt: 1 },
    ...overrides,
  };
}

describe("handleCompactCommand lifecycle authority", () => {
  beforeEach(resetCompactCommandMocks);

  it("keeps the 60-second natural drain retryable and adopts ingress before compacting", async () => {
    let adopted = false;
    const onAdopted = vi.fn(async () => {
      adopted = true;
    });
    const params = buildLifecycleParams({ opts: { turnAdoptionLifecycle: { onAdopted } } });
    const { operation, cancel } = startCompactActiveRun(params);
    vi.mocked(waitForSessionControllerSettlement).mockImplementationOnce(
      async (settled, timeout) => {
        expect(timeout).toBe(60_000);
        expect(adopted).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
        operation.complete();
        await settled;
        return true;
      },
    );
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
      expect(adopted).toBe(true);
      return { ok: true, compacted: false };
    });
    try {
      const result = await handleCompactCommand(params, true);
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
      expect(result?.reply?.text).toContain("Compaction skipped");
    } finally {
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it("adopts before cancelling the captured run and preserves queued input", async () => {
    let adopted = false;
    const params = buildLifecycleParams({
      opts: {
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            adopted = true;
          },
        },
      },
    });
    const { operation, cancel, target } = startCompactActiveRun(params, {
      onCancel: () => expect(adopted).toBe(true),
    });
    const queued = reserveSessionControllerSource(params.sessionKey, {
      target,
      policy: { mode: "followup" },
    });
    vi.mocked(waitForSessionControllerSettlement).mockResolvedValueOnce(false);
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
      expect(operation.abortSignal.aborted).toBe(true);
      await operation.ownerSettlement;
      return { ok: true, compacted: false };
    });
    try {
      const result = await handleCompactCommand(params, true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(result?.reply?.text).toContain("Your in-flight request was aborted by compaction");
      expect(queued.abortSignal.aborted).toBe(false);
      expect(queued.retirementRequested).not.toBe(true);
      expect(queued.mailbox.entries).toContain(queued);
    } finally {
      retireSessionControllerInput(queued);
      await queued.settlement.promise;
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it.each([false, true])(
    "propagates adoption failure before effects, active run=%s",
    async (active) => {
      const error = new Error("ingress adoption lost");
      const params = buildLifecycleParams({
        opts: { turnAdoptionLifecycle: { onAdopted: vi.fn().mockRejectedValue(error) } },
      });
      const running = active ? startCompactActiveRun(params) : undefined;
      vi.mocked(waitForSessionControllerSettlement).mockResolvedValueOnce(false);
      try {
        await expect(handleCompactCommand(params, true)).rejects.toBe(error);
        if (running) {
          expect(running.cancel).not.toHaveBeenCalled();
        }
        expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
      } finally {
        running?.operation.complete();
        await running?.operation.ownerSettlement;
      }
    },
  );

  it.each([false, true])(
    "does not adopt cancelled ingress after preflight, active run=%s",
    async (active) => {
      const controller = new AbortController();
      const onAdopted = vi.fn();
      const params = buildLifecycleParams({
        opts: { turnAdoptionLifecycle: { onAdopted, abortSignal: controller.signal } },
      });
      const running = active ? startCompactActiveRun(params) : undefined;
      vi.mocked(waitForSessionControllerSettlement).mockResolvedValueOnce(false);
      vi.mocked(prepareCurrentSessionEntry).mockImplementationOnce(async ({ expected }) => {
        controller.abort(new Error("ingress stopped"));
        return { entry: { updatedAt: 1, ...expected }, assertCurrent() {}, release() {} };
      });
      try {
        await expect(handleCompactCommand(params, true)).rejects.toThrow("ingress stopped");
        expect(onAdopted).not.toHaveBeenCalled();
        if (running) {
          expect(running.cancel).not.toHaveBeenCalled();
        }
        expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
      } finally {
        running?.operation.complete();
        await running?.operation.ownerSettlement;
      }
    },
  );

  it.each(["caller", "channel owner", "plugin owner", "operator"] as const)(
    "rechecks %s authority after ingress adoption",
    async (authority) => {
      const controller = new AbortController();
      let ownerCurrent = true;
      const assertOwnerCurrent = () => {
        if (!ownerCurrent) {
          throw new Error("Command owner was revoked");
        }
      };
      const params = buildLifecycleParams({
        opts: {
          abortSignal: authority === "caller" ? controller.signal : undefined,
          operatorAuthority:
            authority === "operator"
              ? { profileId: "test", scopes: [], assertCurrent: assertOwnerCurrent }
              : undefined,
          turnAdoptionLifecycle: {
            onAdopted: async () => {
              controller.abort();
              ownerCurrent = false;
            },
          },
        },
      });
      if (authority === "channel owner") {
        params.command.assertOwnerCurrent = assertOwnerCurrent;
      }
      const pending = handleCompactCommand(
        params,
        true,
        authority === "plugin owner" ? assertOwnerCurrent : undefined,
      );
      if (authority === "caller") {
        expect((await pending)?.sessionCompaction?.reason).toBe("command invocation closed");
      } else {
        await expect(pending).rejects.toThrow("Command owner was revoked");
      }
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

  it.each(["invocation", "caller", "owner", "session"] as const)(
    "rejects stale %s authority before cancelling after the natural wait",
    async (authority) => {
      const controller = new AbortController();
      const entry = { sessionId: "session-1", updatedAt: 1 };
      let ownerCurrent = true;
      const params = buildLifecycleParams({
        sessionEntry: entry,
        compactionSessionEntry: entry,
        commandInvocationSignal: authority === "invocation" ? controller.signal : undefined,
        opts: { abortSignal: authority === "caller" ? controller.signal : undefined },
      });
      const { operation, cancel } = startCompactActiveRun(params);
      vi.mocked(waitForSessionControllerSettlement).mockImplementationOnce(async () => {
        if (authority === "session") {
          vi.mocked(prepareCurrentSessionEntry).mockResolvedValueOnce(undefined);
        } else if (authority === "owner") {
          ownerCurrent = false;
        } else {
          controller.abort();
        }
        return false;
      });
      try {
        const pending = handleCompactCommand(params, true, () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        });
        if (authority === "owner") {
          await expect(pending).rejects.toThrow("Command owner was revoked");
        } else {
          expect((await pending)?.sessionCompaction).toEqual({
            compacted: false,
            reason:
              authority === "session" ? "command session changed" : "command invocation closed",
          });
        }
        expect(cancel).not.toHaveBeenCalled();
        expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
        expect(incrementCompactionCount).not.toHaveBeenCalled();
      } finally {
        operation.complete();
        await operation.ownerSettlement;
      }
    },
  );

  it("rechecks the retained writer predicate after ingress adoption before cancelling", async () => {
    let current = true;
    const params = buildLifecycleParams({
      opts: {
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            current = false;
          },
        },
      },
    });
    const { operation, cancel } = startCompactActiveRun(params);
    vi.mocked(waitForSessionControllerSettlement).mockResolvedValueOnce(false);
    vi.mocked(prepareCurrentSessionEntry).mockImplementationOnce(async ({ expected }) => ({
      entry: { updatedAt: 1, ...expected },
      assertCurrent() {
        if (!current) {
          throw new Error("command session changed");
        }
      },
      release() {},
    }));
    try {
      await expect(handleCompactCommand(params, true)).rejects.toThrow("command session changed");
      expect(cancel).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      await operation.ownerSettlement;
    }
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
      await replyOperation.ownerSettlement;
    }
  });

  it("does not compact while the cancelled producer still owns settlement", async () => {
    vi.useFakeTimers();
    const cancelled = createDeferred();
    const params = buildLifecycleParams();
    const { operation } = startCompactActiveRun(params, {
      settleOnCancel: false,
      onCancel: () => cancelled.resolve(),
    });
    vi.mocked(waitForSessionControllerSettlement).mockResolvedValueOnce(false);
    const pending = handleCompactCommand(params, true);
    try {
      await cancelled.promise;
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await pending)?.sessionCompaction).toEqual({
        compacted: false,
        reason: "the previous run is still stopping",
      });
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      await operation.ownerSettlement;
      await pending;
      vi.useRealTimers();
    }
  });

  it("waits for an unabortable producer without cancelling its work", async () => {
    vi.useFakeTimers();
    const params = buildLifecycleParams();
    const { operation, cancel } = startCompactActiveRun(params, { abortable: false });
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
      expect(operation.result).toEqual({ kind: "completed" });
      return { ok: true, compacted: false };
    });
    const pending = handleCompactCommand(params, true);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
      expect(waitForSessionControllerSettlement).not.toHaveBeenCalled();
      operation.complete();
      expect((await pending)?.reply?.text).toContain("Compaction skipped");
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      await operation.ownerSettlement;
      await pending;
      vi.useRealTimers();
    }
  });

  it("preserves the drained writer fence and accounts completed compaction after caller closure", async () => {
    const controller = new AbortController();
    const original = {
      sessionId: "session-1",
      updatedAt: 1,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "earlier-writer",
    };
    let currentEntry = original;
    const params = buildLifecycleParams({
      sessionEntry: original,
      opts: { abortSignal: controller.signal },
    });
    const { operation, cancel } = startCompactActiveRun(params);
    vi.mocked(waitForSessionControllerSettlement).mockImplementationOnce(async (settled) => {
      currentEntry = { ...original, activeWriterRunId: "drained-writer" };
      operation.complete();
      await settled;
      return true;
    });
    vi.mocked(prepareCurrentSessionEntry).mockImplementation(async () => ({
      entry: currentEntry,
      assertCurrent() {},
      release() {},
    }));
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (input, host) => {
      expect(input.sessionEntry).toMatchObject({ activeWriterRunId: "drained-writer" });
      host?.assertActive?.();
      controller.abort(new Error("caller closed"));
      return { ok: true, compacted: true, compactionKind: "native-harness" };
    });
    vi.mocked(incrementCompactionCount).mockImplementationOnce(async ({ expectedSession }) => {
      expect(expectedSession).toMatchObject({ activeWriterRunId: "drained-writer" });
      return 1;
    });
    try {
      const result = await handleCompactCommand(params, true);
      expect(result?.sessionCompaction?.reason).toBe("command invocation closed");
      expect(incrementCompactionCount).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it.each([false, true])(
    "uses the host-accepted successor for accounting, replacement=%s",
    async (replaceBeforeAccounting) => {
      const initial = { sessionId: "native-session", updatedAt: 1, lifecycleRevision: "lifecycle" };
      let ownerCurrent = true;
      vi.mocked(incrementCompactionCount).mockImplementationOnce(
        async ({ expectedSession, transcriptByteCompactionLatch }) => {
          expect(expectedSession?.sessionId).toBe("successor-session");
          expect(transcriptByteCompactionLatch).toBeNull();
          return replaceBeforeAccounting ? undefined : 1;
        },
      );
      vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (params, host) => {
        host?.assertActive?.();
        const storePath = params.sessionTarget?.storePath;
        if (!storePath) {
          throw new Error("expected manual compaction store");
        }
        host?.onCommitted?.({
          sessionId: "successor-session",
          sessionFile: params.sessionFile,
          sessionTarget: {
            agentId: "main",
            sessionId: "successor-session",
            sessionKey: "agent:main:main",
            storePath,
          },
          entry: { ...initial, sessionId: "successor-session" },
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
            sessionId: "successor-session",
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
