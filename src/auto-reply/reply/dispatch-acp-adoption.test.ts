import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRunTurnInput } from "../../acp/control-plane/manager.types.js";
import { runDispatch } from "./dispatch-acp.test-support.js";
import { acpManagerRuntimeMocks, acpMocks } from "./dispatch-from-config.shared.test-harness.js";
import { describe0BeforeEach0, globalBeforeAll0 } from "./dispatch-from-config.test-support.js";
import { createAcpSessionMeta } from "./test-fixtures/acp-runtime.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  const sessionKey = "agent:codex-acp:session-1";
  acpMocks.readAcpSessionEntry.mockReturnValue({
    sessionKey,
    storeSessionKey: sessionKey,
    storePath: "/tmp/mock-sessions.json",
    entry: {},
    acp: createAcpSessionMeta(),
  });
});

describe("ACP prompt adoption", () => {
  it("adopts ACP ingress once before prompt submission, including runtime retry", async () => {
    const onTurnAdopted = vi.fn(async () => {});
    const submitPrompt = vi.fn();
    Object.assign(acpManagerRuntimeMocks.getAcpSessionManager(), {
      runTurn: async (input: AcpRunTurnInput) => {
        await input.onBeforePrompt?.();
        expect(onTurnAdopted).toHaveBeenCalledOnce();
        await input.onBeforePrompt?.();
        submitPrompt();
        await input.onEvent?.({ type: "done", status: "completed" });
      },
    });

    await runDispatch({ bodyForAgent: "review backend", onTurnAdopted });

    expect(onTurnAdopted).toHaveBeenCalledOnce();
    expect(submitPrompt).toHaveBeenCalledOnce();
  });

  it.each(["lost adoption", "cancelled during adoption"])(
    "does not submit the ACP prompt after %s",
    async (failure) => {
      const callerAbort = new AbortController();
      const submitPrompt = vi.fn();
      const onTurnAdopted = vi.fn(async () => {
        if (failure === "lost adoption") {
          throw new Error("ingress claim no longer owned");
        }
        callerAbort.abort(new Error("operator stopped review"));
      });
      Object.assign(acpManagerRuntimeMocks.getAcpSessionManager(), {
        runTurn: async (input: AcpRunTurnInput) => {
          await input.onBeforePrompt?.();
          submitPrompt();
          await input.onEvent?.({ type: "done", status: "completed" });
        },
      });

      await runDispatch({
        bodyForAgent: "review backend",
        onTurnAdopted,
        abortSignal: callerAbort.signal,
      });

      expect(onTurnAdopted).toHaveBeenCalledOnce();
      expect(submitPrompt).not.toHaveBeenCalled();
    },
  );
});
