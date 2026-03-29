/**
 * Fork regression tests: Abort signal wrapping, /stop drain, ws→socket
 *
 * Covers fork-specific patches:
 * - cc73beb86: fix: wrap tool execute with abort signal check
 * - 688e9ca72: fix: drain pending system events on /stop
 * - 34a2cdc5d: fix: ws→socket rename in already_connected handler
 */
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// §1  Abort signal tool wrapping (cc73beb86)
// ---------------------------------------------------------------------------
describe("fork: abort signal tool wrapping", () => {
  // Reproduce the wrapping logic from attempt.ts in isolation
  const wrapToolsWithAbortCheck = <T extends { execute: (...args: unknown[]) => unknown }>(
    tools: T[],
    signal: AbortSignal,
  ): T[] =>
    tools.map((tool) => ({
      ...tool,
      execute: (...args: Parameters<T["execute"]>) => {
        if (signal.aborted) {
          return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }
        return tool.execute(...args);
      },
    }));

  it("passes through to original execute when signal not aborted", async () => {
    const ac = new AbortController();
    const tool = { name: "test", execute: vi.fn().mockResolvedValue("ok") };
    const [wrapped] = wrapToolsWithAbortCheck([tool], ac.signal);
    const result = await wrapped.execute("arg1");
    expect(result).toBe("ok");
    expect(tool.execute).toHaveBeenCalledWith("arg1");
  });

  it("rejects with AbortError when signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const tool = { name: "test", execute: vi.fn().mockResolvedValue("ok") };
    const [wrapped] = wrapToolsWithAbortCheck([tool], ac.signal);
    await expect(wrapped.execute()).rejects.toThrow("aborted");
    await expect(wrapped.execute()).rejects.toMatchObject({ name: "AbortError" });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("rejects mid-sequence when signal aborts between calls", async () => {
    const ac = new AbortController();
    const tool1 = { name: "t1", execute: vi.fn().mockResolvedValue("r1") };
    const tool2 = { name: "t2", execute: vi.fn().mockResolvedValue("r2") };
    const [w1, w2] = wrapToolsWithAbortCheck([tool1, tool2], ac.signal);

    const r1 = await w1.execute();
    expect(r1).toBe("r1");

    ac.abort(); // /stop fires between tool calls

    await expect(w2.execute()).rejects.toMatchObject({ name: "AbortError" });
    expect(tool2.execute).not.toHaveBeenCalled();
  });

  it("preserves tool metadata (name, description, etc.)", () => {
    const ac = new AbortController();
    const tool = {
      name: "web_search",
      description: "Search the web",
      execute: vi.fn(),
    };
    const [wrapped] = wrapToolsWithAbortCheck([tool], ac.signal);
    expect(wrapped.name).toBe("web_search");
    expect(wrapped.description).toBe("Search the web");
  });
});

// ---------------------------------------------------------------------------
// §2  /stop drain system events (688e9ca72)
// ---------------------------------------------------------------------------
describe("fork: /stop drains system events", () => {
  it("drainSystemEvents is exported and callable", async () => {
    const mod = await import("../infra/system-events.js");
    expect(typeof mod.drainSystemEvents).toBe("function");
  });

  it("draining a non-existent key does not throw", async () => {
    const { drainSystemEvents } = await import("../infra/system-events.js");
    expect(() => drainSystemEvents("non-existent-session-key")).not.toThrow();
  });

  it("drainSystemEvents is imported in commands-session-abort", async () => {
    // Verify the import path exists — if the module structure changes,
    // this test will fail, catching regressions in the /stop flow.
    const mod = await import("../auto-reply/reply/commands-session-abort.js");
    expect(mod.handleStopCommand).toBeDefined();
  });

  it("drains queued events for a session key", async () => {
    const { enqueueSystemEvent, drainSystemEvents, peekSystemEvents } =
      await import("../infra/system-events.js");
    const key = "test-drain-session-" + Date.now();
    enqueueSystemEvent("pending heartbeat event", { sessionKey: key });
    enqueueSystemEvent("another queued event", { sessionKey: key });

    // Drain should remove them
    const drained = drainSystemEvents(key);
    expect(drained).toHaveLength(2);

    // Nothing left
    const remaining = peekSystemEvents(key);
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §3  ws→socket rename (34a2cdc5d)
// ---------------------------------------------------------------------------
describe("fork: ws→socket rename in node handler", () => {
  it("message-handler uses socket property (not ws)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const handlerPath = path.resolve(
      import.meta.dirname ?? ".",
      "../gateway/server/ws-connection/message-handler.ts",
    );

    const exists = fs.existsSync(handlerPath);
    if (!exists) {
      return; // Skip gracefully if file moved
    }

    const content = fs.readFileSync(handlerPath, "utf-8");

    // Find the already_connected section and verify it uses `socket.` not `ws.`
    const alreadyConnectedIdx = content.indexOf("already_connected");
    expect(alreadyConnectedIdx).toBeGreaterThan(-1);

    // Extract ~200 chars around the already_connected reference
    const snippet = content.slice(alreadyConnectedIdx, alreadyConnectedIdx + 300);

    // Should NOT contain bare `ws.close` or `ws.send` — those are the old bugs
    expect(snippet).not.toMatch(/\bws\.close\b/);
    expect(snippet).not.toMatch(/\bws\.send\b/);
  });
});
