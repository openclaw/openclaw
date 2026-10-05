import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerModelCapabilityCommands } from "./model.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  complete: vi.fn(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveLocalCapabilityRuntimeConfig: vi.fn(async () => ({})),
}));

vi.mock("./local-account-secrets.js", () => ({
  prepareLocalCapabilityAccountSecrets: vi.fn(async () => {}),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: vi.fn(async () => ({
    async [Symbol.asyncDispose]() {},
    selection: { provider: "openai", modelId: "gpt-5.4", agentDir: "/tmp/agent" },
    model: { provider: "openai", id: "gpt-5.4", maxTokens: 128 },
    auth: { apiKey: "sk-test", source: "env:TEST_API_KEY", mode: "api-key" },
  })),
  completeWithPreparedSimpleCompletionModel: mocks.complete,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  {
    stopReason: "stop",
    error: 'Model returned reasoning but no text output for provider "openai" model "gpt-5.4".',
  },
  {
    stopReason: "length",
    error:
      'Model returned reasoning but no text output for provider "openai" model "gpt-5.4". It stopped at the output token limit while reasoning; a lower --thinking level may leave room for text.',
  },
  {
    stopReason: "error",
    errorMessage: "socket hang up",
    error: 'No text output returned for provider "openai" model "gpt-5.4": socket hang up.',
  },
  {
    stopReason: "aborted",
    error: 'No text output returned for provider "openai" model "gpt-5.4".',
  },
])(
  "picks the local model run no-text error for reasoning plus blank text (stopReason $stopReason)",
  async ({ stopReason, errorMessage, error }) => {
    mocks.complete.mockResolvedValueOnce({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "text", text: " " },
      ],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    });
    const program = new Command();
    program.exitOverride();
    registerModelCapabilityCommands(program);

    await expect(
      program.parseAsync(["model", "run", "--prompt", "hello", "--json"], { from: "user" }),
    ).rejects.toThrow("exit 1");

    expect(mocks.runtime.error.mock.calls.map((call) => call[0])).toEqual([error]);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  },
);
