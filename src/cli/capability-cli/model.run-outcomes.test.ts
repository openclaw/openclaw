import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerModelCapabilityCommands } from "./model.js";

const mocks = await vi.hoisted(async () => ({
  runtime: (await import("../test-runtime-mock.js")).createInertRuntime(vi),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockResolvedValue({
    async [Symbol.asyncDispose]() {},
    selection: { provider: "openai", modelId: "gpt-5.4", agentDir: "/tmp/agent" },
    model: { provider: "openai", id: "gpt-5.4", maxTokens: 128, input: ["text"] },
    auth: { apiKey: "sk-test", source: "env:TEST_API_KEY", mode: "api-key" },
  });
});

async function runModel(...options: string[]) {
  const program = new Command().exitOverride();
  registerModelCapabilityCommands(program);
  return await program.parseAsync(["model", "run", "--prompt", "hello", "--json", ...options], {
    from: "user",
  });
}

async function expectOutcome(run: Promise<unknown>, error?: string) {
  if (error) {
    await expect(run).rejects.toThrow("exit 1");
    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  } else {
    await run;
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ok: true,
        outputs: [expect.objectContaining({ text: "complete answer" })],
      }),
      2,
    );
  }
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
  ["aborted", "partial", undefined, `Model run aborted ${target}.`],
])("handles local %s with text %j", async (stopReason, text, errorMessage, error) => {
  mocks.complete.mockResolvedValueOnce({
    role: "assistant",
    stopReason,
    errorMessage,
    content: [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text },
    ],
  });
  await expectOutcome(runModel(), error);
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
      ...(detail ? { meta: { error: { kind: "incomplete_turn", message: detail } } } : {}),
    },
  });
  await expectOutcome(runModel("--gateway"), error);
});

it("rejects --file before sending it to a text-only local model", async () =>
  withOpenClawTestState({}, async (state) => {
    const file = await state.writeText("pixel.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(runModel("--local", "--file", file)).rejects.toThrow("exit 1");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(
      'Model "openai/gpt-5.4" does not accept image input, so --file cannot be sent to it. Use an image-capable model, run openclaw infer image describe, or add --gateway to describe images for text-only models.',
    );
  }));
