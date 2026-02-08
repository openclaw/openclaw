import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

import { runCommandWithTimeout } from "../../process/exec.js";
import { generateSmartAck, startSmartAck } from "./smart-ack.js";

const mockedRun = vi.mocked(runCommandWithTimeout);

function cliJsonResult(text: string) {
  return { code: 0, stdout: JSON.stringify({ result: text }), stderr: "" };
}

const baseCfg = {} as Parameters<typeof generateSmartAck>[0]["cfg"];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateSmartAck prefix parsing", () => {
  it("strips FULL: prefix and returns isFull=true", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello there!"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "Hello there!", isFull: true });
  });

  it("strips ACK: prefix and returns isFull=false", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("ACK: Working on that..."));
    const result = await generateSmartAck({ message: "explain quantum physics", cfg: baseCfg });
    expect(result).toEqual({ text: "Working on that...", isFull: false });
  });

  it("strips SIMPLE: prefix and treats as isFull=true", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("SIMPLE: The memory is located at ~/.claude/"));
    const result = await generateSmartAck({ message: "where is the memory?", cfg: baseCfg });
    expect(result).toEqual({ text: "The memory is located at ~/.claude/", isFull: true });
  });

  it("strips FULL: prefix without space after colon", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL:No space here"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "No space here", isFull: true });
  });

  it("strips SIMPLE: prefix without space after colon", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("SIMPLE:No space here either"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "No space here either", isFull: true });
  });

  it("passes through response with no recognized prefix", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("Just a plain response"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "Just a plain response", isFull: false });
  });

  it("returns null for empty response after prefix strip", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL:   "));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toBeNull();
  });

  it("returns null when CLI fails", async () => {
    mockedRun.mockResolvedValue({ code: 1, stdout: "", stderr: "error" });
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toBeNull();
  });

  it("returns null when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateSmartAck({
      message: "hi",
      cfg: baseCfg,
      signal: controller.signal,
    });
    expect(result).toBeNull();
  });
});

describe("generateSmartAck triage behavior", () => {
  it("uses sonnet as default model", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello!"));
    await generateSmartAck({ message: "hi", cfg: baseCfg });
    const args = mockedRun.mock.calls[0]?.[0];
    const modelIndex = args.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(args[modelIndex + 1]).toBe("sonnet");
  });

  it("allows overriding model via config", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello!"));
    await generateSmartAck({
      message: "hi",
      cfg: baseCfg,
      config: { model: "haiku" },
    });
    const args = mockedRun.mock.calls[0]?.[0];
    const modelIndex = args.indexOf("--model");
    expect(args[modelIndex + 1]).toBe("haiku");
  });

  it("includes agent identity in prompt when context is provided", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hey friend!"));
    await generateSmartAck({
      message: "hi",
      cfg: baseCfg,
      context: {
        agentName: "Claw",
        agentVibe: "warm and friendly",
        agentCreature: "digital lobster",
        isDirectMessage: true,
      },
    });
    const args = mockedRun.mock.calls[0]?.[0];
    const promptIndex = args.indexOf("-p");
    const prompt = args[promptIndex + 1] ?? "";
    expect(prompt).toContain("Your name is Claw.");
    expect(prompt).toContain("warm and friendly");
    expect(prompt).toContain("digital lobster");
    expect(prompt).toContain("Discord DM");
  });

  it("includes conversation context in prompt", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Sure thing!"));
    await generateSmartAck({
      message: "thanks",
      cfg: baseCfg,
      context: {
        conversationContext: "[Discord DM] Alice: Can you help me with something?\nBot: Of course!",
        isDirectMessage: true,
      },
    });
    const args = mockedRun.mock.calls[0]?.[0];
    const promptIndex = args.indexOf("-p");
    const prompt = args[promptIndex + 1] ?? "";
    expect(prompt).toContain("Recent conversation context:");
    expect(prompt).toContain("Can you help me with something?");
  });

  it("includes channel system prompt for guild messages", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Welcome!"));
    await generateSmartAck({
      message: "hello",
      cfg: baseCfg,
      context: {
        channelSystemPrompt: "Be extra polite in this channel.",
        isDirectMessage: false,
      },
    });
    const args = mockedRun.mock.calls[0]?.[0];
    const promptIndex = args.indexOf("-p");
    const prompt = args[promptIndex + 1] ?? "";
    expect(prompt).toContain("Channel guidelines:");
    expect(prompt).toContain("Be extra polite");
    expect(prompt).toContain("Discord server");
  });

  it("skips conversation context when it matches the message", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello!"));
    await generateSmartAck({
      message: "hi",
      cfg: baseCfg,
      context: {
        conversationContext: "hi",
        isDirectMessage: true,
      },
    });
    const args = mockedRun.mock.calls[0]?.[0];
    const promptIndex = args.indexOf("-p");
    const prompt = args[promptIndex + 1] ?? "";
    expect(prompt).not.toContain("Recent conversation context:");
  });
});

describe("startSmartAck controller", () => {
  it("resolves immediately without delay", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello!"));
    const controller = startSmartAck({
      message: "hi",
      cfg: baseCfg,
    });
    const result = await controller.result;
    expect(result).toEqual({ text: "Hello!", isFull: true });
  });

  it("returns null when cancelled before CLI completes", async () => {
    // Mock that resolves after a short delay, giving us time to cancel.
    mockedRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(cliJsonResult("FULL: Hello!")), 50);
        }),
    );
    const controller = startSmartAck({
      message: "hi",
      cfg: baseCfg,
    });
    // Cancel immediately (before the 50ms mock resolves).
    controller.cancel();
    const result = await controller.result;
    // generateSmartAck checks signal.aborted after CLI returns and returns null.
    expect(result).toBeNull();
  });
});

describe("tool-request guardrail", () => {
  it("overrides FULL to ACK when message asks to read a file", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Found ~/git/misc/nana-peter/..."));
    const result = await generateSmartAck({
      message: "pick a random file on my device and read it",
      cfg: baseCfg,
    });
    expect(result).toEqual({
      text: "Found ~/git/misc/nana-peter/...",
      isFull: false,
    });
  });

  it("overrides FULL to ACK when message mentions 'my device'", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Sure, your device has..."));
    const result = await generateSmartAck({
      message: "what files are on my device",
      cfg: baseCfg,
    });
    expect(result).toEqual({ text: "Sure, your device has...", isFull: false });
  });

  it("overrides FULL to ACK when message asks to run a command", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: The result is 42"));
    const result = await generateSmartAck({
      message: "run command ls in my home directory",
      cfg: baseCfg,
    });
    expect(result).toEqual({ text: "The result is 42", isFull: false });
  });

  it("does not override FULL for casual conversation", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello there!"));
    const result = await generateSmartAck({
      message: "hey, how are you?",
      cfg: baseCfg,
    });
    expect(result).toEqual({ text: "Hello there!", isFull: true });
  });
});
