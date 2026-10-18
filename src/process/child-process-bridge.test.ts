import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { attachChildProcessBridge } from "./child-process-bridge.js";

describe("attachChildProcessBridge", () => {
  it.each([true, false])("retains handlers until close (child emitted exit=%s)", (exited) => {
    const signal: NodeJS.Signals = "SIGTERM";
    const existingListeners = new Set(process.listeners(signal));
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const onSignal = vi.fn();
    child.on("error", () => {});
    const { detach } = attachChildProcessBridge(child, { signals: [signal], onSignal });
    const signalListener = process
      .listeners(signal)
      .find((listener) => !existingListeners.has(listener));
    try {
      expect(signalListener).toBeDefined();
      child.emit("error", new Error("signal delivery failed"));
      expect(process.listeners(signal)).toContain(signalListener);
      signalListener?.(signal);
      expect(kill).toHaveBeenCalledExactlyOnceWith(signal);
      expect(onSignal).toHaveBeenCalledExactlyOnceWith(signal);
      if (exited) {
        child.emit("exit", 0, null);
        expect(process.listeners(signal)).toContain(signalListener);
        signalListener?.(signal);
        expect(kill).toHaveBeenCalledOnce();
        expect(onSignal).toHaveBeenCalledOnce();
      }
      child.emit("close", 0, null);
      expect(process.listeners(signal)).not.toContain(signalListener);
    } finally {
      detach();
      kill.mockRestore();
    }
  });
});
