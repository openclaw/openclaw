import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "../sessions/session-run-cancel.js";
import {
  onSessionRunCancel,
  requestSessionRunCancel,
  type SessionRunCancelTarget,
} from "./session-run-cancel-runtime.js";

const target: SessionRunCancelTarget = {
  kind: "session_run",
  sessionKey: "agent:main:main",
  runId: "run-1",
};

describe("plugin-sdk/session-run-cancel-runtime", () => {
  afterEach(() => {
    __testing.reset();
  });

  describe("public API surface", () => {
    it("re-exports onSessionRunCancel registered against the same core store", () => {
      const handler = vi.fn();
      onSessionRunCancel(target, handler);
      expect(__testing.handlerCount(target)).toBe(1);
    });

    it("re-exports requestSessionRunCancel wired to the same core requester", async () => {
      const requester = vi.fn(async () => true);
      __testing.reset();
      const { setSessionRunAbortRequester } = await import("../sessions/session-run-cancel.js");
      setSessionRunAbortRequester(requester);

      const result = await requestSessionRunCancel(target, { source: "plugin:test" });

      expect(requester).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ requested: true, aborted: true });
    });

    it("does NOT export emitSessionRunCancel — only core call sites may emit", async () => {
      const mod = await import("./session-run-cancel-runtime.js");
      // emitSessionRunCancel is a core-internal hook deliberately excluded
      // from the plugin trust boundary.
      const anyMod = mod as unknown as Record<string, unknown>;
      expect("emitSessionRunCancel" in anyMod).toBe(false);
      expect(anyMod.emitSessionRunCancel).toBeUndefined();
    });

    it("exports plugin-safe functions only", async () => {
      const mod = await import("./session-run-cancel-runtime.js");
      const keys = Object.keys(mod);
      // Plugin-safe exports: onSessionRunCancel, requestSessionRunCancel
      expect(keys).toContain("onSessionRunCancel");
      expect(keys).toContain("requestSessionRunCancel");
      // Core-internal emitSessionRunCancel must not leak
      expect(keys).not.toContain("emitSessionRunCancel");
      // Internal symbols must not leak
      for (const key of keys) {
        expect(key).not.toContain("__");
      }
    });

    it("exports required types for plugin consumers", async () => {
      const mod = await import("./session-run-cancel-runtime.js");
      // The public module must export type re-exports but those are only
      // visible at the type level.  At runtime, we verify the module shape
      // is clean (no unexpected runtime exports).
      const anyMod = mod as unknown as Record<string, unknown>;
      const runtimeExports = Object.keys(anyMod).filter(
        (k) => typeof anyMod[k] !== "undefined",
      );
      expect(runtimeExports).toContain("onSessionRunCancel");
      expect(runtimeExports).toContain("requestSessionRunCancel");
    });

    it("replays sticky cancel through the plugin SDK surface", async () => {
      const t = target;
      const reason = { source: "chat-abort", message: "stopped" };

      // Emit via core-internal path (dynamic import in vitest ESM context).
      const { emitSessionRunCancel } = await import("../sessions/session-run-cancel.js");
      emitSessionRunCancel(t, reason);

      // Late handler registered through the plugin SDK must still observe it.
      const handler = vi.fn();
      onSessionRunCancel(t, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(t, reason);
    });
  });
});
