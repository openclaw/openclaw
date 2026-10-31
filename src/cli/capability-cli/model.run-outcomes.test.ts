import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import type { NormalizedUsage, UsageLike } from "../../agents/usage.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerCapabilityCli } from "../capability-cli.js";
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

async function runPromptInput(root: string, ...options: string[]) {
  const argv = [root, "model", "run", ...options, "--json"];
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  await registerCapabilityCli(program, ["node", "openclaw", ...argv]);
  return await program.parseAsync(argv, { from: "user" });
}

it.each([
  ["infer", "--local", "file"],
  ["capability", "--gateway", "file"],
  ["infer", "--local", "stdin"],
  ["capability", "--gateway", "stdin"],
])(
  "reads bounded prompts through %s %s from %s without printing the input",
  async (root, transport, source) =>
    withOpenClawTestState({}, async (state) => {
      const prompt = `  private UTF-8: café\n${"x".repeat(1_048_548)}🦞\n`;
      expect(Buffer.byteLength(prompt)).toBe(1_048_576);
      await state.writeText("prompt.txt", prompt);
      using _ = vi.spyOn(process, "cwd").mockReturnValue(state.stateDir);
      const bytes = Buffer.from(prompt);
      const stream = Readable.from([bytes.subarray(0, -3), bytes.subarray(-3)]);
      using stdin = vi.spyOn(process, "stdin", "get");
      stdin.mockReturnValue(stream as typeof process.stdin);
      mocks.complete.mockResolvedValue({ content: [{ type: "text", text: "answer" }] });
      mocks.callGateway.mockResolvedValue({ result: { payloads: [{ text: "answer" }] } });

      await runPromptInput(
        root,
        ...(source === "file" ? ["--prompt-file", "prompt.txt"] : ["--prompt-stdin"]),
        transport,
      );
      expect(stream.readableDidRead).toBe(source === "stdin");

      if (transport === "--local") {
        expect(mocks.complete.mock.calls[0]?.[0]?.context.messages[0].content).toBe(prompt);
      } else {
        expect(mocks.callGateway.mock.calls[0]?.[0]?.params).toMatchObject({
          message: prompt,
          modelRun: true,
        });
      }
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true }),
        2,
      );
      expect(
        JSON.stringify([
          mocks.runtime.log.mock.calls,
          mocks.runtime.error.mock.calls,
          mocks.runtime.writeJson.mock.calls,
        ]),
      ).not.toContain("private UTF-8");
    }),
);

it.each(["missing", "empty", "oversized", "traversal", "symlink", "conflict"])(
  "rejects %s prompt files before inference",
  async (scenario) =>
    withOpenClawTestState({}, async (state) => {
      const dir = state.path("allowed");
      await fs.mkdir(dir);
      await fs.writeFile(state.path("private.txt"), "outside private prompt");
      const content =
        scenario === "empty" ? " \n" : "x".repeat(scenario === "oversized" ? 1_048_577 : 1);
      if (scenario === "symlink") {
        await fs.symlink(state.root, path.join(dir, "alias"), "junction");
      } else if (scenario !== "missing") {
        await fs.writeFile(path.join(dir, "prompt.txt"), content);
      }
      using _ = vi.spyOn(process, "cwd").mockReturnValue(dir);
      const file =
        scenario === "traversal"
          ? "../private.txt"
          : scenario === "symlink"
            ? "alias/private.txt"
            : "prompt.txt";

      await expect(
        runPromptInput(
          "infer",
          "--prompt-file",
          file,
          ...(scenario === "conflict" ? ["--prompt", "argv prompt"] : []),
        ),
      ).rejects.toThrow("exit 1");

      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    }),
);

it.each([
  { bytes: Buffer.from(" \n"), error: "empty or whitespace-only" },
  { bytes: Buffer.from("é".repeat(524_289)), error: "limit: 1048576 bytes" },
  { bytes: Buffer.from([0xc3, 0x28]), error: "valid UTF-8" },
  { bytes: undefined, error: "stdin fixture read failure" },
])("rejects invalid stdin before inference: $error", async ({ bytes, error }) => {
  const stream = bytes
    ? Readable.from([bytes])
    : new Readable({
        read() {
          this.destroy(new Error(error));
        },
      });
  using _ = vi.spyOn(process, "stdin", "get").mockReturnValue(stream as typeof process.stdin);
  await expect(runPromptInput("infer", "--prompt-stdin")).rejects.toThrow("exit 1");
  expect(mocks.runtime.error.mock.calls.flat().join(" ")).toContain(error);
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it.each([
  [],
  ["--prompt", "hello", "--prompt-stdin"],
  ["--prompt-file", "prompt.txt", "--prompt-stdin"],
  ["--prompt", "hello", "--prompt-file", "prompt.txt", "--prompt-stdin"],
])(
  "rejects conflicting or missing prompt sources without reading stdin: %j",
  async (...options) => {
    const stream = Readable.from(["unselected stdin"]);
    using _ = vi.spyOn(process, "stdin", "get").mockReturnValue(stream as typeof process.stdin);
    await expect(runPromptInput("infer", ...options)).rejects.toThrow("exit 1");
    expect(mocks.runtime.error.mock.calls.flat().join(" ")).toContain("Use exactly one");
    expect(stream.readableDidRead).toBe(false);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  },
);

const target = 'for provider "openai" model "gpt-5.4"';
const reasoningOnly = `Model returned reasoning but no text output ${target}.`;
const limitHint =
  " It stopped at the output token limit while reasoning; a lower --thinking level may leave room for text.";
it.each<[string, string, string, string | undefined, string | undefined]>([
  ["local", "stop", " ", undefined, reasoningOnly],
  ["local", "length", " ", undefined, reasoningOnly + limitHint],
  ["local", "error", " ", "socket hang up", `No text output returned ${target}: socket hang up.`],
  ["local", "aborted", " ", undefined, `No text output returned ${target}.`],
  ["local", "error", "partial", "socket hang up", `Model run failed ${target}: socket hang up.`],
  ["local", "aborted", "partial", undefined, `Model run aborted ${target}.`],
  ["gateway", "error", "stream failed", "failed", "stream failed"],
  ["gateway", "timeout", "", "aborted", "aborted"],
  ["gateway", "cancelled", "", undefined, "Gateway model run cancelled."],
  ["gateway", "ok", "", undefined, undefined],
  ["gateway", "completed", "", undefined, undefined],
])("handles %s status %s (%j)", async (transport, status, text, detail, error) => {
  mocks.complete.mockResolvedValue({
    role: "assistant",
    stopReason: status,
    errorMessage: detail,
    content: [
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text },
    ],
  });
  mocks.callGateway.mockResolvedValue({
    status,
    summary: detail,
    result: {
      payloads: [{ text: error ? "partial" : "complete answer" }],
      ...(text ? { meta: { error: { kind: "incomplete_turn", message: text } } } : {}),
    },
  });
  const run = runModel(`--${transport}`);
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
});

for (const transport of ["local", "gateway"] as const) {
  it.each<[string, UsageLike | undefined, NormalizedUsage | undefined]>([
    ["absent", undefined, undefined],
    ["adapter-default zeros", { input: 0, output: 0, total: 0, cost: { total: 0 } }, undefined],
    [
      "reported",
      {
        input: 17,
        output: 4,
        totalTokens: 21,
        cost: { total: 0.25, totalOrigin: "provider-billed" },
      },
      { input: 17, output: 4, total: 21, cost: { total: 0.25, totalOrigin: "provider-billed" } },
    ],
    [
      "measured zeros",
      { input: 0, output: 0, totalTokens: 0, usageReport: { state: "available" } },
      { input: 0, output: 0, total: 0, usageReport: { state: "available" } },
    ],
    [
      "unavailable",
      { input: 17, usageReport: { state: "unavailable" } },
      { usageReport: { state: "unavailable" }, contextUsage: { state: "unavailable" } },
    ],
  ])(`preserves ${transport} usage observations: %s`, async (_name, usage, expected) => {
    const gatewayUsage = expected ?? usage;
    const agentMeta = { usage: gatewayUsage, lastCallUsage: gatewayUsage };
    mocks.complete.mockResolvedValue({ content: [{ type: "text", text: "OK" }], usage });
    mocks.callGateway.mockResolvedValue({
      result: { payloads: [{ text: "OK", mediaUrl: null }], meta: { agentMeta } },
    });
    await runModel(`--${transport}`);
    const json = JSON.stringify(mocks.runtime.writeJson.mock.calls[0]?.[0]);
    const envelope = JSON.parse(json);
    expect(envelope.usage).toEqual(expected);
    expect(envelope.lastCallUsage).toEqual(expected);
  });
}

it.each([
  ["unavailable", 48],
  ["complete", 0],
  ["unavailable", 0],
] as const)(
  "preserves %s Gateway billing totals of %s separately from last-call usage",
  async (costStatus, total) => {
    const usage = {
      total,
      costStatus,
      ...(total ? { input: 40, output: 8 } : {}),
      ...(costStatus === "complete" ? { cost: { total: 0 } } : {}),
    };
    const lastCallUsage = total ? { input: 7, output: 2, total: 9 } : undefined;
    mocks.callGateway.mockResolvedValue({
      result: { meta: { agentMeta: { usage, lastCallUsage } } },
    });
    await runModel("--gateway");
    expect(mocks.runtime.writeJson.mock.calls[0]?.[0]).toMatchObject({
      usage: { total, costStatus, ...(costStatus === "complete" ? { cost: { total: 0 } } : {}) },
      lastCallUsage: total ? { total: 9 } : undefined,
    });
  },
);

it("rejects --file before sending it to a text-only local model", async () =>
  withOpenClawTestState({}, async (state) => {
    const file = await state.writeText("pixel.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(runModel("--local", "--file", file)).rejects.toThrow("exit 1");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(
      'Model "openai/gpt-5.4" does not accept image input, so --file cannot be sent to it. Use an image-capable model, run openclaw infer image describe, or add --gateway to describe images for text-only models.',
    );
  }));
