import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { registerModelCapabilityCommands } from "./model.js";

const mocks = await vi.hoisted(async () => ({
  runtime: (await import("../test-runtime-mock.js")).createInertRuntime(vi),
  status: vi.fn<(opts: unknown, runtime: RuntimeEnv) => Promise<void>>(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

// mock-isolation: Supply the selected agent's config without opening the configuration database.
vi.mock("../../config/config.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

// mock-isolation: Agent selection is covered separately; avoid loading provider and secret owners.
vi.mock("./shared.js", () => ({
  resolveCapabilityAgentOption: () => "main",
  resolveCapabilityProviderAgentId: () => "main",
}));

// mock-isolation: Supply status diagnostics and results without provider discovery or auth stores.
vi.mock("../../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: mocks.status,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockReset();
});

async function runAuthStatus(...args: string[]) {
  const program = new Command();
  registerModelCapabilityCommands(program.command("infer"));
  return await program.parseAsync(
    ["infer", "model", "auth", "status", "--agent", "main", ...args],
    {
      from: "user",
    },
  );
}

it.each([
  { mode: "JSON", args: ["--json"] },
  { mode: "text", args: [] },
])("preserves model auth status when the catalog warns in $mode mode", async ({ mode, args }) => {
  const warning =
    'Configured model "ollama/missing:latest" is absent. The model remains selectable.';
  const status = { auth: { providers: [{ provider: "ollama", effective: { kind: "env" } }] } };
  mocks.status.mockImplementationOnce(async (_opts, runtime) => {
    runtime.error(warning);
    runtime.log(JSON.stringify(status));
  });

  await runAuthStatus(...args);

  expect(mocks.runtime.error).toHaveBeenCalledExactlyOnceWith(warning);
  if (mode === "JSON") {
    expect(mocks.runtime.writeJson.mock.calls[0]?.[0]).toEqual(status);
  } else {
    expect(JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0]))).toEqual(status);
  }
  expect(mocks.runtime.exit).not.toHaveBeenCalled();
});

it("still fails model auth status when the status command throws", async () => {
  mocks.status.mockRejectedValueOnce(new Error("auth state unavailable"));

  await expect(runAuthStatus("--json")).rejects.toThrow("exit 1");

  expect(mocks.runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("auth state unavailable"),
  );
  expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
});
