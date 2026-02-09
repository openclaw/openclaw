import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn(() => false),
}));

// Import after mocks are set up
const { createUnifiedToolFeedback, createToolFeedbackFilter } =
  await import("./tool-feedback-filter.js");

describe("createUnifiedToolFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not emit immediately when a tool is pushed", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({ onUpdate });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    expect(onUpdate).not.toHaveBeenCalled();
    filter.dispose();
  });

  it("emits formatted feedback after debounce window", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 1000, maxWaitMs: 5000, cooldownMs: 0 },
    });

    filter.push({
      toolName: "Read",
      toolCallId: "call-1",
      input: { file_path: "/home/user/file.ts" },
    });

    vi.advanceTimersByTime(1100);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const text = onUpdate.mock.calls[0][0] as string;
    // Should use code block formatting with no colon
    expect(text).toContain("📖");
    expect(text).toContain("Reading");
    expect(text).toContain("`");
    expect(text).not.toContain(":");
    filter.dispose();
  });

  it("groups multiple same-tool calls with counts", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 1000, maxWaitMs: 5000, cooldownMs: 0 },
    });

    // Push 3 Read calls for different files
    filter.push({
      toolName: "Read",
      toolCallId: "call-1",
      input: { file_path: "/a.ts" },
    });
    filter.push({
      toolName: "Read",
      toolCallId: "call-2",
      input: { file_path: "/b.ts" },
    });
    filter.push({
      toolName: "Read",
      toolCallId: "call-3",
      input: { file_path: "/c.ts" },
    });

    vi.advanceTimersByTime(1100);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const text = onUpdate.mock.calls[0][0] as string;
    expect(text).toContain("(x3)");
    filter.dispose();
  });

  it("groups homogeneous Bash commands with base command", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 1000, maxWaitMs: 5000, cooldownMs: 0 },
    });

    // 7 gog calendar events calls with different calendar IDs
    for (let i = 0; i < 7; i++) {
      filter.push({
        toolName: "Bash",
        toolCallId: `call-${i}`,
        input: {
          command: `export GOG_ACCOUNT=test@gmail.com && gog calendar events 'calendar-id-${i}@group.calendar.google.com'`,
        },
      });
    }

    vi.advanceTimersByTime(1100);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const text = onUpdate.mock.calls[0][0] as string;
    expect(text).toContain("gog calendar events");
    expect(text).toContain("(x7)");
    // Should not contain individual calendar IDs
    expect(text).not.toContain("calendar-id-");
    filter.dispose();
  });

  it("shows multiple tool groups on separate lines", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 1000, maxWaitMs: 5000, cooldownMs: 0 },
    });

    filter.push({
      toolName: "Read",
      toolCallId: "call-1",
      input: { file_path: "/a.ts" },
    });
    filter.push({
      toolName: "Bash",
      toolCallId: "call-2",
      input: { command: "git status" },
    });

    vi.advanceTimersByTime(1100);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const text = onUpdate.mock.calls[0][0] as string;
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Reading");
    expect(lines[1]).toContain("Running");
    filter.dispose();
  });

  it("rate limits output with cooldown", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 500, maxWaitMs: 2000, cooldownMs: 5000 },
    });

    // First batch
    filter.push({ toolName: "Read", toolCallId: "call-1" });
    vi.advanceTimersByTime(600);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Second batch arrives too soon (within cooldown)
    filter.push({ toolName: "Bash", toolCallId: "call-2" });
    vi.advanceTimersByTime(600);
    // Should not have emitted yet
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Advance past cooldown
    vi.advanceTimersByTime(5000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    filter.dispose();
  });

  it("suppresses updates for given duration", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 500, maxWaitMs: 2000, cooldownMs: 0 },
    });

    filter.suppress(5000);
    filter.push({ toolName: "Read", toolCallId: "call-1" });
    vi.advanceTimersByTime(600);
    expect(onUpdate).not.toHaveBeenCalled();

    // After suppression ends
    vi.advanceTimersByTime(5000);
    filter.push({ toolName: "Bash", toolCallId: "call-2" });
    vi.advanceTimersByTime(600);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    filter.dispose();
  });

  it("does not emit after dispose", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 500, cooldownMs: 0 },
    });

    filter.push({ toolName: "Bash", toolCallId: "call-1" });
    filter.dispose();

    vi.advanceTimersByTime(1000);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("flushes on max-wait even if tools keep arriving", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 3000, maxWaitMs: 5000, cooldownMs: 0 },
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    vi.advanceTimersByTime(2000);
    filter.push({ toolName: "Bash", toolCallId: "call-2" });
    vi.advanceTimersByTime(2000);
    filter.push({ toolName: "Read", toolCallId: "call-3" });
    // At 4s, push resets debounce but max-wait at 5s still fires
    vi.advanceTimersByTime(1100);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    filter.dispose();
  });

  it("formats Bash commands in inline code", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 500, cooldownMs: 0 },
    });

    filter.push({
      toolName: "Bash",
      toolCallId: "call-1",
      input: { command: "npm install" },
    });

    vi.advanceTimersByTime(600);

    const text = onUpdate.mock.calls[0][0] as string;
    expect(text).toContain("Running `npm install`");
    filter.dispose();
  });

  it("caps output at 5 lines with overflow indicator", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 500, cooldownMs: 0 },
    });

    // Push 8 different tool types to force 8 separate lines
    const tools = ["Read", "Bash", "Write", "Edit", "web_search", "web_fetch", "glob", "grep"];
    for (let i = 0; i < tools.length; i++) {
      filter.push({
        toolName: tools[i],
        toolCallId: `call-${i}`,
        input: { command: `cmd-${i}`, file_path: `/file-${i}`, query: `q-${i}` },
      });
    }

    vi.advanceTimersByTime(600);

    const text = onUpdate.mock.calls[0][0] as string;
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(6); // 5 + overflow line
    expect(lines.at(-1)).toContain("more");
    filter.dispose();
  });

  it("strips env var exports from Bash base command", () => {
    const onUpdate = vi.fn();
    const filter = createUnifiedToolFeedback({
      onUpdate,
      config: { bufferMs: 500, cooldownMs: 0 },
    });

    filter.push({
      toolName: "Bash",
      toolCallId: "call-1",
      input: {
        command:
          "export GOG_ACCOUNT=test@gmail.com && gog calendar events 'some-id@group.calendar.google.com'",
      },
    });

    vi.advanceTimersByTime(600);

    const text = onUpdate.mock.calls[0][0] as string;
    expect(text).toContain("gog calendar events");
    expect(text).not.toContain("GOG_ACCOUNT");
    filter.dispose();
  });
});

describe("backward compatibility", () => {
  it("exports createToolFeedbackFilter as an alias", () => {
    expect(createToolFeedbackFilter).toBe(createUnifiedToolFeedback);
  });
});
