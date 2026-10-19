import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsCli } from "../../cli/models-cli.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

describe.each([
  {
    name: "fallbacks",
    label: "Fallbacks",
    key: "model" as const,
    model: "anthropic/claude-sonnet-4-6",
  },
  {
    name: "image-fallbacks",
    label: "Image fallbacks",
    key: "imageModel" as const,
    model: "openai/gpt-image-1",
  },
])("models $name list", (testCase) => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset();
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          [testCase.key]: { fallbacks: [testCase.model] },
        },
      },
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["--json", testCase.name, "list"],
    [testCase.name, "list", "--json"],
  ])("writes JSON and attributes diagnostics for %s %s %s", async (...args) => {
    await runRegisteredCli({ register: registerModelsCli, argv: ["models", ...args] });

    expect(mocks.loadModelsConfig).toHaveBeenCalledWith({
      commandName: `models ${testCase.name} list`,
      runtime: defaultRuntime,
    });
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls.map(([value]) => value)).toEqual([
      {
        fallbacks: [testCase.model],
      },
    ]);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it("writes populated plain output directly to stdout", async () => {
    await runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", testCase.name, "list", "--plain"],
    });

    expect(defaultRuntime.writeStdout).toHaveBeenCalledExactlyOnceWith(testCase.model);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([{ flags: [] }, { flags: ["--plain"] }])(
    "escapes control characters in text output (%j)",
    async ({ flags }) => {
      const model = "openai/café\u001b[2J\nforged";
      mocks.loadModelsConfig.mockResolvedValue({
        agents: { defaults: { [testCase.key]: { fallbacks: [model] } } },
      });
      await runRegisteredCli({
        register: registerModelsCli,
        argv: ["models", testCase.name, "list", ...flags],
      });
      const output = [
        ...vi.mocked(defaultRuntime.log).mock.calls,
        ...vi.mocked(defaultRuntime.writeStdout).mock.calls,
      ]
        .flat()
        .join("\n");
      expect(output).toContain("openai/café\\nforged");
      expect(output).not.toContain("\u001b");
      await runRegisteredCli({
        register: registerModelsCli,
        argv: ["models", testCase.name, "list", "--json"],
      });
      expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ fallbacks: [model] }, 2);
    },
  );

  it.each([false, true])("preserves human output (empty: %s)", async (empty) => {
    if (empty) {
      mocks.loadModelsConfig.mockResolvedValue({});
    }
    await runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", testCase.name, "list"],
    });

    expect(vi.mocked(defaultRuntime.log).mock.calls).toEqual([
      [`${testCase.label} (${empty ? 0 : 1}):`],
      [empty ? "- none" : `- ${testCase.model}`],
    ]);
  });
});
