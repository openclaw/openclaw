import { describe, expect, it, vi } from "vitest";
import { createToolProgressController, type ToolProgressAdapter } from "./tool-progress.js";

function createMockAdapter() {
  const messages: Array<{ id: number; text: string }> = [];
  let nextId = 1;
  const adapter: ToolProgressAdapter = {
    send: vi.fn(async (text: string) => {
      const id = nextId++;
      messages.push({ id, text });
      return id;
    }),
    edit: vi.fn(async (messageId: string | number, text: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg) {
        msg.text = text;
      }
    }),
    delete: vi.fn(async (messageId: string | number) => {
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        messages.splice(idx, 1);
      }
    }),
  };
  return { adapter, messages };
}

describe("createToolProgressController", () => {
  it("does nothing when disabled", async () => {
    const { adapter } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: false,
      adapter,
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: ls -la");
    ctrl.onToolEnd("tc-1", "exec", "🔧 exec: ls -la", false);
    await ctrl.cleanup();

    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.edit).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it("sends a status message on first tool start", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: ls -la");
    // Allow async flush
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    expect(messages.length).toBe(1);
    expect(messages[0].text).toContain("🔧 exec: ls -la");

    await ctrl.cleanup();
  });

  it("edits existing message on subsequent updates", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: ls -la");
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    ctrl.onToolEnd("tc-1", "exec", "🔧 exec: ls -la", false);
    ctrl.onToolStart("tc-2", "read", "📖 read: src/index.ts");
    await vi.waitFor(() => {
      expect(adapter.edit).toHaveBeenCalled();
    });

    // Should have sent once and edited at least once
    expect(adapter.send).toHaveBeenCalledTimes(1);
    // Message should show completed tool and active tool
    const lastText = messages[0].text;
    expect(lastText).toContain("✅");
    expect(lastText).toContain("📖 read: src/index.ts");

    await ctrl.cleanup();
  });

  it("shows error mark for failed tools", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: bad-cmd");
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    ctrl.onToolEnd("tc-1", "exec", "🔧 exec: bad-cmd", true);
    await vi.waitFor(() => {
      expect(adapter.edit).toHaveBeenCalled();
    });

    const lastText = messages[0].text;
    expect(lastText).toContain("❌");

    await ctrl.cleanup();
  });

  it("cleanup deletes the status message", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: ls");
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    expect(messages.length).toBe(1);
    await ctrl.cleanup();
    expect(adapter.delete).toHaveBeenCalledWith(1);
    expect(messages.length).toBe(0);
  });

  it("uses tool name as fallback when meta is undefined", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "web_search", undefined);
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    expect(messages[0].text).toContain("web_search");

    await ctrl.cleanup();
  });

  it("respects maxVisibleTools", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0, maxVisibleTools: 2 },
    });

    // Complete 3 tools then start a 4th
    ctrl.onToolStart("tc-1", "tool1", "step 1");
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));

    ctrl.onToolEnd("tc-1", "tool1", "step 1", false);
    ctrl.onToolStart("tc-2", "tool2", "step 2");
    await vi.waitFor(() => expect(adapter.edit).toHaveBeenCalled());

    ctrl.onToolEnd("tc-2", "tool2", "step 2", false);
    ctrl.onToolStart("tc-3", "tool3", "step 3");
    // Wait for edits to propagate
    await new Promise((r) => setTimeout(r, 50));

    ctrl.onToolEnd("tc-3", "tool3", "step 3", false);
    ctrl.onToolStart("tc-4", "tool4", "step 4");
    // Wait for all edits to flush
    await new Promise((r) => setTimeout(r, 50));

    // With maxVisibleTools=2 and 3 completed + 1 active, should show "... 1 more"
    const lastText = messages[0].text;
    expect(lastText).toContain("... 1 more");
    expect(lastText).toContain("step 4");

    await ctrl.cleanup();
  });

  it("handles adapter errors gracefully", async () => {
    const onError = vi.fn();
    const adapter: ToolProgressAdapter = {
      send: vi.fn(async () => {
        throw new Error("send failed");
      }),
      edit: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };

    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
      onError,
    });

    ctrl.onToolStart("tc-1", "exec", "test");
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });

    // Should not throw
    await ctrl.cleanup();
  });

  // --- Concurrent tool execution tests ---

  it("tracks multiple concurrent tools independently", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: ls");
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));

    ctrl.onToolStart("tc-2", "web_search", "🔍 web_search: weather");
    await new Promise((r) => setTimeout(r, 50));

    // Both tools should be shown as active
    const text = messages[0].text;
    expect(text).toContain("🔧 exec: ls");
    expect(text).toContain("🔍 web_search: weather");

    await ctrl.cleanup();
  });

  it("ending one concurrent tool does not clear others", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-1", "exec", "🔧 exec: ls");
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));

    ctrl.onToolStart("tc-2", "web_search", "🔍 web_search: weather");
    await new Promise((r) => setTimeout(r, 50));

    // End tool A — tool B should still be active
    ctrl.onToolEnd("tc-1", "exec", "🔧 exec: ls", false);
    await new Promise((r) => setTimeout(r, 50));

    const text = messages[0].text;
    expect(text).toContain("✅ 🔧 exec: ls");
    expect(text).toContain("⏳ 🔍 web_search: weather");

    await ctrl.cleanup();
  });

  it("retires the correct tool by toolCallId", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    ctrl.onToolStart("tc-A", "exec", "task A");
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));

    ctrl.onToolStart("tc-B", "exec", "task B");
    ctrl.onToolStart("tc-C", "exec", "task C");
    await new Promise((r) => setTimeout(r, 50));

    // End the middle one (tc-B)
    ctrl.onToolEnd("tc-B", "exec", "task B", false);
    await new Promise((r) => setTimeout(r, 50));

    const text = messages[0].text;
    // tc-B completed, tc-A and tc-C still active
    expect(text).toContain("✅ task B");
    expect(text).toContain("⏳ task A");
    expect(text).toContain("⏳ task C");

    await ctrl.cleanup();
  });

  it("handles anonymous tool calls (no toolCallId)", async () => {
    const { adapter, messages } = createMockAdapter();
    const ctrl = createToolProgressController({
      enabled: true,
      adapter,
      config: { throttleMs: 0 },
    });

    // No toolCallId — should still work with anonymous fallback
    ctrl.onToolStart(undefined, "exec", "anon task");
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(1));

    expect(messages[0].text).toContain("anon task");

    // End without toolCallId — should clear the anonymous entry
    ctrl.onToolEnd(undefined, "exec", "anon task", false);
    await new Promise((r) => setTimeout(r, 50));

    const text = messages[0].text;
    expect(text).toContain("✅ anon task");
    expect(text).not.toContain("⏳");

    await ctrl.cleanup();
  });
});
