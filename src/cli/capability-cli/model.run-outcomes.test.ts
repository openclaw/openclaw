import "../../test-utils/prepare-compiled-subprocesses.js";
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
  callGateway: vi.fn(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveLocalCapabilityRuntimeConfig: vi.fn(async () => ({})),
}));

// mock-isolation: Supply final Gateway run outcomes without opening a WebSocket connection.
vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  randomIdempotencyKey: () => "model-run-outcome-test",
}));

// mock-isolation: Keep local account secret reads out of this command diagnostic test.
vi.mock("./local-account-secrets.js", () => ({
  prepareLocalCapabilityAccountSecrets: vi.fn(async () => {}),
}));

// mock-isolation: Supply controlled provider completions without opening auth stores or transports.
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

async function runModel(...options: string[]) {
  const program = new Command();
  program.exitOverride();
  registerModelCapabilityCommands(program);
  return await program.parseAsync(["model", "run", "--prompt", "hello", "--json", ...options], {
    from: "user",
  });
}

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
  {
    stopReason: "error",
    text: "partial answer",
    errorMessage: "socket hang up",
    error: 'Model run failed for provider "openai" model "gpt-5.4": socket hang up.',
  },
  {
    stopReason: "error",
    text: "partial answer",
    error: 'Model run failed for provider "openai" model "gpt-5.4".',
  },
  {
    stopReason: "aborted",
    text: "partial answer",
    errorMessage: "request cancelled",
    error: 'Model run aborted for provider "openai" model "gpt-5.4": request cancelled.',
  },
  {
    stopReason: "aborted",
    text: "partial answer",
    error: 'Model run aborted for provider "openai" model "gpt-5.4".',
  },
])(
  "rejects an unsuccessful local model response (stopReason $stopReason, text $text)",
  async ({ stopReason, text = " ", errorMessage, error }) => {
    mocks.complete.mockResolvedValueOnce({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "text", text },
      ],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    });
    await expect(runModel()).rejects.toThrow("exit 1");

    expect(mocks.runtime.error.mock.calls.map((call) => call[0])).toEqual([error]);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  },
);

it.each(["stop", "length"])(
  "keeps text output successful for stopReason %s",
  async (stopReason) => {
    mocks.complete.mockResolvedValueOnce({
      role: "assistant",
      content: [{ type: "text", text: "complete answer" }],
      stopReason,
    });
    await runModel();

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ok: true,
        outputs: [{ text: "complete answer", mediaUrl: null }],
      }),
      2,
    );
  },
);

it.each([
  { status: "error", detail: "stream failed", summary: "failed", expected: "stream failed" },
  { status: "timeout", summary: "aborted", expected: "aborted" },
  { status: "cancelled", expected: "Gateway model run cancelled." },
])(
  "rejects a Gateway model run with status $status",
  async ({ status, detail, summary, expected }) => {
    mocks.callGateway.mockResolvedValueOnce({
      status,
      summary,
      result: {
        payloads: [{ text: "partial answer" }],
        meta: detail ? { error: { kind: "incomplete_turn", message: detail } } : {},
      },
    });
    await expect(runModel("--gateway")).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(expected);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  },
);

it.each(["ok", "completed"])(
  "keeps Gateway model output successful for status %s",
  async (status) => {
    mocks.callGateway.mockResolvedValueOnce({
      status,
      result: { payloads: [{ text: "complete answer" }] },
    });
    await runModel("--gateway");

    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ok: true,
        outputs: [{ text: "complete answer", mediaUrl: undefined, mediaUrls: undefined }],
      }),
      2,
    );
  },
);
