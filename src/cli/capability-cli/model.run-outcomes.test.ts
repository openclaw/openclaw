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
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "model-run-")), "pixel.png");
  await fs.writeFile(
    file,
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  return file;
}

async function runModel(...options: string[]) {
  const program = new Command().exitOverride();
  registerModelCapabilityCommands(program);
  return await program.parseAsync(["model", "run", "--prompt", "hello", "--json", ...options], {
    from: "user",
  });
}

function completion(text: string, stopReason = "stop", reasoning = false) {
  const content = [
    ...(reasoning ? [{ type: "thinking", thinking: "private chain of thought" }] : []),
    { type: "text", text },
  ];
  return { role: "assistant", stopReason, content };
}

function expectOutput(output: { text: string; mediaUrl: null | undefined; mediaUrls?: undefined }) {
  expect(mocks.runtime.exit).not.toHaveBeenCalled();
  expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ ok: true, outputs: [output] }),
    2,
  );
}

const target = 'for provider "openai" model "gpt-5.4"';
const reasoningOnly = `Model returned reasoning but no text output ${target}.`;
const limitHint =
  " It stopped at the output token limit while reasoning; a lower --thinking level may leave room for text.";
it.each<[string, string, string | undefined, string | undefined]>([
  ["stop", " ", undefined, reasoningOnly],
  ["length", " ", undefined, reasoningOnly + limitHint],
  ["error", " ", "socket hang up", `No text output returned ${target}: socket hang up.`],
  ["aborted", " ", undefined, `No text output returned ${target}.`],
  ["error", "partial", "socket hang up", `Model run failed ${target}: socket hang up.`],
  ["error", "partial", undefined, `Model run failed ${target}.`],
  ["aborted", "partial", "request cancelled", `Model run aborted ${target}: request cancelled.`],
  ["aborted", "partial", undefined, `Model run aborted ${target}.`],
  ["stop", "complete answer", undefined, undefined],
  ["length", "complete answer", undefined, undefined],
])("handles local %s with text %j", async (stopReason, text, errorMessage, error) => {
  mocks.complete.mockResolvedValueOnce({
    ...completion(text, stopReason, Boolean(error)),
    ...(errorMessage ? { errorMessage } : {}),
  });
  if (error) {
    await expect(runModel()).rejects.toThrow("exit 1");
    expect(mocks.runtime.error.mock.calls.map((call) => call[0])).toEqual([error]);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  } else {
    await runModel();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expectOutput({ text: "complete answer", mediaUrl: null });
  }
});

it.each<[string, string?, string?, string?]>([
  ["error", "stream failed", "failed", "stream failed"],
  ["timeout", undefined, "aborted", "aborted"],
  ["cancelled", undefined, undefined, "Gateway model run cancelled."],
  ["ok"],
  ["completed"],
])("handles Gateway status %s", async (status, detail, summary, error) => {
  mocks.callGateway.mockResolvedValueOnce({
    status,
    summary,
    result: {
      payloads: [{ text: error ? "partial" : "complete answer" }],
      ...(error
        ? { meta: detail ? { error: { kind: "incomplete_turn", message: detail } } : {} }
        : {}),
    },
  });
  if (error) {
    await expect(runModel("--gateway")).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  } else {
    await runModel("--gateway");
    expectOutput({ text: "complete answer", mediaUrl: undefined, mediaUrls: undefined });
  }
});

it.each([false, true])("gates --file on local image support: %s", async (images) => {
  mocks.acquire.mockResolvedValueOnce(preparedModel(images ? ["text", "image"] : ["text"]));
  mocks.complete.mockResolvedValueOnce(completion("a pixel"));
  const file = await writePngFixture();
  if (images) {
    await runModel("--local", "--file", file);
    const [{ context }] = mocks.complete.mock.calls[0] as [
      { context: { messages: Array<{ content: unknown }> } },
    ];
    expect(context.messages[0]?.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: expect.any(String), mimeType: "image/png" },
    ]);
  } else {
    await expect(runModel("--local", "--file", file)).rejects.toThrow("exit 1");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(
      'Model "openai/gpt-5.4" does not accept image input, so --file cannot be sent to it. Use an image-capable model, run openclaw infer image describe, or add --gateway to describe images for text-only models.',
    );
  }
});
