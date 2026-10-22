// Tests compact-command authority and settlement through the real session controller.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import {
  buildCompactParams,
  compactEmbeddedAgentSession,
  enqueueSystemEvent,
  formatContextUsageShort,
  handleCompactCommand,
  incrementCompactionCount,
  prepareCurrentSessionEntry,
  requireCompactEmbeddedAgentSessionCall,
  resetCompactCommandMocks,
  startCompactActiveRun as createActiveRun,
  waitForSessionControllerSettlement,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

function buildLifecycleParams(
  overrides: Partial<HandleCommandsParams> = {},
  onAdopted?: () => Promise<void>,
): HandleCommandsParams {
  return {
    ...buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    }),
    sessionEntry: { sessionId: "session-1", updatedAt: 1 },
    ...overrides,
    ...(onAdopted && { opts: { ...overrides.opts, turnAdoptionLifecycle: { onAdopted } } }),
  };
}

const operations: ReturnType<typeof createReplyOperation>[] = [];
function startCompactActiveRun(...args: Parameters<typeof createActiveRun>) {
  const run = createActiveRun(...args);
  operations.push(run.operation);
  return run;
}

describe("handleCompactCommand lifecycle authority", () => {
  beforeEach(resetCompactCommandMocks);
  afterEach(async () => {
    for (const operation of operations.splice(0)) {
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it("adopts before cancelling the captured run and preserves queued input", async () => {
    let adopted = false;
    const params = buildLifecycleParams({}, async () => {
      adopted = true;
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
    }
  });

  it.each([
    { active: false, cancelled: false },
    { active: true, cancelled: false },
    { active: false, cancelled: true },
    { active: true, cancelled: true },
  ])(
    "rejects ingress before effects, cancelled=$cancelled active=$active",
    async ({ active, cancelled }) => {
      const error = new Error(cancelled ? "ingress stopped" : "ingress adoption lost");
      const controller = new AbortController();
      const onAdopted = vi.fn<() => Promise<void>>().mockRejectedValue(error);
      const params = buildLifecycleParams({
        opts: { turnAdoptionLifecycle: { onAdopted, abortSignal: controller.signal } },
      });
      const running = active ? startCompactActiveRun(params) : undefined;
      vi.mocked(waitForSessionControllerSettlement).mockResolvedValueOnce(false);
      if (cancelled) {
        vi.mocked(prepareCurrentSessionEntry).mockImplementationOnce(async ({ expected }) => {
          controller.abort(error);
          return { entry: { updatedAt: 1, ...expected }, assertCurrent() {}, release() {} };
        });
      }
      await expect(handleCompactCommand(params, true)).rejects.toBe(error);
      if (cancelled) {
        expect(onAdopted).not.toHaveBeenCalled();
      }
      if (running) {
        expect(running.cancel).not.toHaveBeenCalled();
      }
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
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
      const params = buildLifecycleParams(
        {
          opts: {
            abortSignal: authority === "caller" ? controller.signal : undefined,
            operatorAuthority:
              authority === "operator"
                ? { profileId: "test", scopes: [], assertCurrent: assertOwnerCurrent }
                : undefined,
          },
        },
        async () => {
          controller.abort();
          ownerCurrent = false;
        },
      );
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
      const { cancel } = startCompactActiveRun(params);
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
          reason: authority === "session" ? "command session changed" : "command invocation closed",
        });
      }
      expect(cancel).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
      expect(incrementCompactionCount).not.toHaveBeenCalled();
    },
  );

  it("rechecks the retained writer predicate after ingress adoption before cancelling", async () => {
    let current = true;
    const params = buildLifecycleParams({}, async () => {
      current = false;
    });
    const { cancel } = startCompactActiveRun(params);
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
    await expect(handleCompactCommand(params, true)).rejects.toThrow("command session changed");
    expect(cancel).not.toHaveBeenCalled();
    expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
  });

  it("marks manual compaction as maintenance until the command finishes", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:telegram:slash:test",
      sessionId: "command-operation",
      resetTriggered: false,
    });
    operations.push(replyOperation);
    replyOperation.setPhase("running");
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
      expect(replyOperation.phase).toBe("preflight_compacting");
      return { ok: true, compacted: false };
    });
    await handleCompactCommand(buildLifecycleParams({ opts: { replyOperation } }), true);
    expect(replyOperation.phase).toBe("running");
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
    const onAdopted = vi.fn(async () => {});
    const original = {
      sessionId: "session-1",
      updatedAt: 1,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "earlier-writer",
    };
    let currentEntry = original;
    const params = buildLifecycleParams(
      { sessionEntry: original, opts: { abortSignal: controller.signal } },
      onAdopted,
    );
    const { operation, cancel } = startCompactActiveRun(params);
    vi.mocked(waitForSessionControllerSettlement).mockImplementationOnce(
      async (settled, timeout) => {
        expect(timeout).toBe(60_000);
        expect(onAdopted).not.toHaveBeenCalled();
        expect(operation.abortSignal.aborted).toBe(false);
        currentEntry = { ...original, activeWriterRunId: "drained-writer" };
        operation.complete();
        await settled;
        return true;
      },
    );
    vi.mocked(prepareCurrentSessionEntry).mockImplementation(async () => ({
      entry: currentEntry,
      assertCurrent() {},
      release() {},
    }));
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (input, host) => {
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(input.sessionEntry).toMatchObject({ activeWriterRunId: "drained-writer" });
      host?.assertActive?.();
      controller.abort(new Error("caller closed"));
      return { ok: true, compacted: true, compactionKind: "native-harness" };
    });
    vi.mocked(incrementCompactionCount).mockImplementationOnce(async ({ expectedSession }) => {
      expect(expectedSession).toMatchObject({ activeWriterRunId: "drained-writer" });
      return 1;
    });
    const result = await handleCompactCommand(params, true);
    expect(result?.sessionCompaction?.reason).toBe("command invocation closed");
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(incrementCompactionCount).toHaveBeenCalledOnce();
    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "active Codex runtime config instead of stale session metadata",
      cfg: {
        agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
        models: { providers: { openai: { models: [{ id: "gpt-5.5", contextWindow: 258_000 }] } } },
      } as unknown as OpenClawConfig,
      provider: "openai",
      model: "openai/gpt-5.5",
      session: { sessionId: "live-session", contextTokens: 400_000 },
      result: {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          firstKeptEntryId: "first-kept",
          tokensBefore: 199_000,
          tokensAfter: 56_000,
        },
      },
      budget: 258_000,
    },
    {
      name: "persisted context for an unknown custom model with a legacy alias",
      cfg: {
        agents: { defaults: { models: { "custom/actual-model": { alias: "legacy-fast-model" } } } },
      },
      provider: "custom",
      model: "actual-model",
      session: {
        sessionId: "legacy-model-session",
        contextTokens: 777_777,
        providerOverride: "custom",
        modelOverride: "legacy-fast-model",
        modelOverrideSource: "user",
      },
      result: { ok: true, compacted: false, reason: "already compacted" },
      budget: 777_777,
    },
  ] as const)("resolves $name", async ({ cfg, provider, model, session, result, budget }) => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce(result);
    await handleCompactCommand(
      buildLifecycleParams({
        cfg: {
          ...cfg,
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        },
        provider,
        model,
        contextTokens: 0,
        sessionEntry: { ...session, updatedAt: Date.now() },
      }),
      true,
    );
    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(budget);
    if (result.compacted) {
      expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
    }
  });
});
