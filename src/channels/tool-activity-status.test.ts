import { describe, expect, it, vi } from "vitest";
import {
  createToolActivityStatusController,
  type ToolActivityAdapter,
} from "./tool-activity-status.js";

function createMockAdapter(): ToolActivityAdapter & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    sendMessage: async (text: string) => {
      calls.push({ method: "sendMessage", args: [text] });
      return "msg-1";
    },
    editMessage: async (messageId: string, text: string) => {
      calls.push({ method: "editMessage", args: [messageId, text] });
    },
    deleteMessage: async (messageId: string) => {
      calls.push({ method: "deleteMessage", args: [messageId] });
    },
  };
}

describe("createToolActivityStatusController", () => {
  it("returns no-op controller when level is off", () => {
    const adapter = createMockAdapter();
    const ctrl = createToolActivityStatusController({ adapter, level: "off" });
    ctrl.onToolStart("exec");
    ctrl.onToolEnd("exec");
    expect(adapter.calls).toHaveLength(0);
  });

  it("sends a message on first tool start", async () => {
    vi.useFakeTimers();
    const adapter = createMockAdapter();
    const ctrl = createToolActivityStatusController({ adapter, level: "minimal" });
    ctrl.onToolStart("exec");
    // Flush the debounce timer
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.calls.length).toBeGreaterThanOrEqual(1);
    expect(adapter.calls[0].method).toBe("sendMessage");
    vi.useRealTimers();
  });

  it("edits message on subsequent tool starts", async () => {
    vi.useFakeTimers();
    const adapter = createMockAdapter();
    const ctrl = createToolActivityStatusController({ adapter, level: "minimal" });
    ctrl.onToolStart("exec");
    await vi.advanceTimersByTimeAsync(500);
    ctrl.onToolEnd("exec");
    ctrl.onToolStart("web_search");
    await vi.advanceTimersByTimeAsync(500);
    const editCalls = adapter.calls.filter((c) => c.method === "editMessage");
    expect(editCalls.length).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("cleanup deletes message when all tools completed", async () => {
    vi.useFakeTimers();
    const adapter = createMockAdapter();
    const ctrl = createToolActivityStatusController({ adapter, level: "minimal" });
    ctrl.onToolStart("exec");
    await vi.advanceTimersByTimeAsync(500);
    ctrl.onToolEnd("exec");
    await vi.advanceTimersByTimeAsync(500);
    await ctrl.cleanup();
    await vi.advanceTimersByTimeAsync(3000);
    const deleteCalls = adapter.calls.filter((c) => c.method === "deleteMessage");
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });
});
