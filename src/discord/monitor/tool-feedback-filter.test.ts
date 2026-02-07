import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("../../infra/errors.js", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

const mockRunCommandWithTimeout = vi.fn();
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => mockRunCommandWithTimeout(...args),
}));

// Import after mocks are set up
const { createToolFeedbackFilter } = await import("./tool-feedback-filter.js");

describe("createToolFeedbackFilter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunCommandWithTimeout.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not emit immediately when a tool is pushed", () => {
    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Tell me about the codebase",
      onUpdate,
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(mockRunCommandWithTimeout).not.toHaveBeenCalled();
    filter.dispose();
  });

  it("flushes buffered tools to Haiku after debounce window", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "Exploring the codebase..." }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Tell me about the codebase",
      onUpdate,
      config: { bufferMs: 3000, maxWaitMs: 8000 },
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    filter.push({ toolName: "Read", toolCallId: "call-2" });
    filter.push({ toolName: "Grep", toolCallId: "call-3" });

    // Advance past the debounce window
    await vi.advanceTimersByTimeAsync(3100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(1);

    // Verify the CLI was called with the correct tool summary
    const cliArgs = mockRunCommandWithTimeout.mock.calls[0];
    const promptArg = cliArgs[0].find(
      (_: string, i: number, arr: string[]) => i > 0 && arr[i - 1] === "-p",
    );
    expect(promptArg).toContain("Read (x2)");
    expect(promptArg).toContain("Grep");

    expect(onUpdate).toHaveBeenCalledWith("*Exploring the codebase...*");
    filter.dispose();
  });

  it("skips update when Haiku returns SKIP", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "SKIP" }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "What is this repo?",
      onUpdate,
      config: { bufferMs: 1000 },
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    filter.push({ toolName: "Glob", toolCallId: "call-2" });

    await vi.advanceTimersByTimeAsync(1100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    filter.dispose();
  });

  it("flushes on max-wait even if tools keep arriving", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "Running tests..." }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Run the tests",
      onUpdate,
      config: { bufferMs: 3000, maxWaitMs: 5000 },
    });

    // Push tools every 2 seconds, which keeps resetting the debounce
    filter.push({ toolName: "Read", toolCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(2000);
    filter.push({ toolName: "Bash", toolCallId: "call-2" });
    await vi.advanceTimersByTimeAsync(2000);
    // We're now at 4s. Push another tool to reset debounce again.
    filter.push({ toolName: "Read", toolCallId: "call-3" });

    // At 5s the max-wait timer fires despite debounce not expiring
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("*Running tests...*");
    filter.dispose();
  });

  it("does not emit after dispose", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "Doing something..." }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Do something",
      onUpdate,
      config: { bufferMs: 1000 },
    });

    filter.push({ toolName: "Bash", toolCallId: "call-1" });
    filter.dispose();

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockRunCommandWithTimeout).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("handles CLI failure gracefully without emitting", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "CLI failed",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Help me debug",
      onUpdate,
      config: { bufferMs: 1000 },
    });

    filter.push({ toolName: "Bash", toolCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    filter.dispose();
  });

  it("handles CLI timeout gracefully", async () => {
    mockRunCommandWithTimeout.mockRejectedValue(new Error("timeout"));

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Do something",
      onUpdate,
      config: { bufferMs: 1000 },
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(1100);

    expect(onUpdate).not.toHaveBeenCalled();
    filter.dispose();
  });

  it("batches tool counts correctly in the summary", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "SKIP" }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "What is this?",
      onUpdate,
      config: { bufferMs: 1000 },
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    filter.push({ toolName: "Read", toolCallId: "call-2" });
    filter.push({ toolName: "Read", toolCallId: "call-3" });
    filter.push({ toolName: "Grep", toolCallId: "call-4" });
    filter.push({ toolName: "Bash", toolCallId: "call-5" });
    filter.push({ toolName: "Bash", toolCallId: "call-6" });

    await vi.advanceTimersByTimeAsync(1100);

    const cliArgs = mockRunCommandWithTimeout.mock.calls[0];
    const promptArg = cliArgs[0].find(
      (_: string, i: number, arr: string[]) => i > 0 && arr[i - 1] === "-p",
    );
    expect(promptArg).toContain("Read (x3)");
    expect(promptArg).toContain("Grep");
    expect(promptArg).toContain("Bash (x2)");
    filter.dispose();
  });

  it("passes correct CLI arguments for Haiku", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "SKIP" }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Test message",
      onUpdate,
      config: { model: "haiku", timeoutMs: 5000, bufferMs: 500 },
    });

    filter.push({ toolName: "Read", toolCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(600);

    const [command, opts] = mockRunCommandWithTimeout.mock.calls[0];
    expect(command[0]).toBe("claude");
    expect(command).toContain("--model");
    expect(command).toContain("haiku");
    expect(command).toContain("--output-format");
    expect(command).toContain("json");
    expect(command).toContain("--max-turns");
    expect(command).toContain("1");
    expect(opts).toEqual({ timeoutMs: 5000 });
    filter.dispose();
  });

  it("handles multiple flushes across the lifecycle", async () => {
    let callCount = 0;
    mockRunCommandWithTimeout.mockImplementation(async () => {
      callCount++;
      return {
        code: 0,
        stdout: JSON.stringify({ result: callCount === 1 ? "SKIP" : "Writing files..." }),
        stderr: "",
      };
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Refactor the code",
      onUpdate,
      config: { bufferMs: 1000, maxWaitMs: 5000 },
    });

    // First batch: routine reads (Haiku returns SKIP)
    filter.push({ toolName: "Read", toolCallId: "call-1" });
    filter.push({ toolName: "Read", toolCallId: "call-2" });
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();

    // Second batch: writes (Haiku returns status)
    filter.push({ toolName: "Write", toolCallId: "call-3" });
    filter.push({ toolName: "Edit", toolCallId: "call-4" });
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("*Writing files...*");
    filter.dispose();
  });

  it("includes tool args in batch summary when provided", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "Reading the backlog file..." }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Read a random file and tell me what's in it",
      onUpdate,
      config: { bufferMs: 1000 },
    });

    filter.push({
      toolName: "Glob",
      toolCallId: "call-1",
      input: { pattern: "**/*.md" },
    });
    filter.push({
      toolName: "Read",
      toolCallId: "call-2",
      input: { file_path: "/home/user/git/BACKLOG.md" },
    });

    await vi.advanceTimersByTimeAsync(1100);

    expect(mockRunCommandWithTimeout).toHaveBeenCalledTimes(1);
    const cliArgs = mockRunCommandWithTimeout.mock.calls[0];
    const promptArg = cliArgs[0].find(
      (_: string, i: number, arr: string[]) => i > 0 && arr[i - 1] === "-p",
    );
    // Verify tool details are included in the prompt
    expect(promptArg).toContain("**/*.md");
    expect(promptArg).toContain("BACKLOG.md");
    // Verify user message context is in the prompt
    expect(promptArg).toContain("Read a random file");
    expect(onUpdate).toHaveBeenCalledWith("*Reading the backlog file...*");
    filter.dispose();
  });

  it("truncates long tool details to max length", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "SKIP" }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Search something",
      onUpdate,
      config: { bufferMs: 500 },
    });

    const longPath =
      "/a/very/deeply/nested/directory/structure/that/goes/on/and/on/forever/file.ts";
    filter.push({
      toolName: "Read",
      toolCallId: "call-1",
      input: { file_path: longPath },
    });

    await vi.advanceTimersByTimeAsync(600);

    const cliArgs = mockRunCommandWithTimeout.mock.calls[0];
    const promptArg = cliArgs[0].find(
      (_: string, i: number, arr: string[]) => i > 0 && arr[i - 1] === "-p",
    );
    // Long details should be truncated with ellipsis
    expect(promptArg).toContain("…");
    expect(promptArg).not.toContain(longPath);
    filter.dispose();
  });

  it("includes command detail for Bash tools", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "Running npm install..." }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Install the dependencies",
      onUpdate,
      config: { bufferMs: 500 },
    });

    filter.push({
      toolName: "Bash",
      toolCallId: "call-1",
      input: { command: "npm install" },
    });

    await vi.advanceTimersByTimeAsync(600);

    const cliArgs = mockRunCommandWithTimeout.mock.calls[0];
    const promptArg = cliArgs[0].find(
      (_: string, i: number, arr: string[]) => i > 0 && arr[i - 1] === "-p",
    );
    expect(promptArg).toContain("npm install");
    expect(onUpdate).toHaveBeenCalledWith("*Running npm install...*");
    filter.dispose();
  });

  it("omits details for unknown tool types", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: "SKIP" }),
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Do something",
      onUpdate,
      config: { bufferMs: 500 },
    });

    filter.push({
      toolName: "UnknownTool",
      toolCallId: "call-1",
      input: { someKey: "someValue" },
    });

    await vi.advanceTimersByTimeAsync(600);

    const cliArgs = mockRunCommandWithTimeout.mock.calls[0];
    const promptArg = cliArgs[0].find(
      (_: string, i: number, arr: string[]) => i > 0 && arr[i - 1] === "-p",
    );
    // Should just have the tool name without details
    expect(promptArg).toContain("UnknownTool");
    expect(promptArg).not.toContain("someValue");
    filter.dispose();
  });

  it("parses plain text CLI responses (non-JSON)", async () => {
    mockRunCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "Searching the web...",
      stderr: "",
    });

    const onUpdate = vi.fn();
    const filter = createToolFeedbackFilter({
      userMessage: "Search for something",
      onUpdate,
      config: { bufferMs: 500 },
    });

    filter.push({ toolName: "WebSearch", toolCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(600);

    expect(onUpdate).toHaveBeenCalledWith("*Searching the web...*");
    filter.dispose();
  });
});
