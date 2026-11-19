import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// A stage child that cannot start or be reached fails the re-bind step; nothing escapes it.
const children = vi.hoisted(() => ({ mode: "spawn-error" as "spawn-error" | "send-error" }));
// mock-isolation: fork is the boundary under test; a real child cannot be made to fail on demand.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => {
        child.signalCode = "SIGKILL";
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      }),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
        if (children.mode === "send-error") {
          queueMicrotask(() => callback(new Error("channel closed")));
        }
      }),
    });
    if (children.mode === "spawn-error") {
      // A child that never spawned emits only `error`.
      queueMicrotask(() => child.emit("error", new Error("spawn EAGAIN")));
    }
    return child;
  },
}));

const { stageEndpointKey } = await import("../tunnel-runtime.js");

describe("a stage child that fails", () => {
  it.each(["spawn-error", "send-error"] as const)(
    "rejects the step on %s",
    async (mode) => {
      children.mode = mode;
      await expect(stageEndpointKey("/nonexistent/openclaw-id-stage")).rejects.toThrow(
        "could not stage the next endpoint key",
      );
      // Settled by the failure itself, not by the 30-second stage deadline.
    },
    2_000,
  );
});
