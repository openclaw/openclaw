import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  acquire: vi.fn(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveLocalCapabilityRuntimeConfig: vi.fn(async () => ({})),
}));

// mock-isolation: Ordinary model runs must not load the catalog used for case-only overrides.
vi.mock("../../agents/prepared-model-catalog.js", () => {
  throw new Error("Model runs without a case-only override must not load catalog runtime");
});

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
  acquireSimpleCompletionModelForAgent: mocks.acquire,
  completeWithPreparedSimpleCompletionModel: mocks.complete,
}));

function preparedModel(input: string[]) {
  return {
    async [Symbol.asyncDispose]() {},
    selection: { provider: "openai", modelId: "gpt-5.4", agentDir: "/tmp/agent" },
    model: { provider: "openai", id: "gpt-5.4", maxTokens: 128, input },
    auth: { apiKey: "sk-test", source: "env:TEST_API_KEY", mode: "api-key" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockImplementation(async () => preparedModel(["text", "image"]));
});

async function writePngFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-run-image-"));
  const file = path.join(dir, "digits.png");
  await fs.writeFile(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return file;
}

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

it("rejects --file images for a text-only local model before calling the provider", async () => {
  mocks.acquire.mockImplementationOnce(async () => preparedModel(["text"]));
  const file = await writePngFixture();

  await expect(runModel("--local", "--file", file)).rejects.toThrow("exit 1");

  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(
    'Model "openai/gpt-5.4" does not accept image input, so --file cannot be sent to it. Use an image-capable model, run openclaw infer image describe, or add --gateway to describe images for text-only models.',
  );
});

it("sends --file images to an image-capable local model", async () => {
  mocks.complete.mockResolvedValueOnce({
    role: "assistant",
    content: [{ type: "text", text: "a pixel" }],
    stopReason: "stop",
  });
  const file = await writePngFixture();

  await runModel("--local", "--file", file);

  const [{ context }] = mocks.complete.mock.calls[0] as [
    { context: { messages: Array<{ content: unknown }> } },
  ];
  expect(context.messages[0]?.content).toEqual([
    { type: "text", text: "hello" },
    { type: "image", data: expect.any(String), mimeType: "image/png" },
  ]);
});
