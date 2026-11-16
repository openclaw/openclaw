import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsCli } from "../../cli/models-cli.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({ loadModelsConfig: vi.fn() }));
// mock-isolation: CLI fallback cases supply their own config without reading operator state.
vi.mock("./load-config.js", () => ({ loadModelsConfig: mocks.loadModelsConfig }));

describe.each([
  ["fallbacks", "Fallbacks", "model", "anthropic/claude-sonnet-4-6"],
  ["image-fallbacks", "Image fallbacks", "imageModel", "openai/gpt-image-1"],
])("models %s list", (name, label, key, defaultModel) => {
  const run = (...args: string[]) =>
    runRegisteredCli({ register: registerModelsCli, argv: ["models", ...args] });
  const list = (...flags: string[]) => run(name, "list", ...flags);
  const setFallback = (model: string) =>
    mocks.loadModelsConfig.mockResolvedValue({
      agents: { defaults: { [key]: { fallbacks: [model] } } },
    });
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset();
    setFallback(defaultModel);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["--json", name, "list"],
    [name, "list", "--json"],
  ])("writes JSON and attributes diagnostics for %s %s %s", async (...args) => {
    await run(...args);

    expect(mocks.loadModelsConfig).toHaveBeenCalledWith({
      commandName: `models ${name} list`,
      runtime: defaultRuntime,
    });
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls.map(([value]) => value)).toEqual([
      { fallbacks: [defaultModel] },
    ]);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it("writes populated plain output directly to stdout", async () => {
    await list("--plain");

    expect(defaultRuntime.writeStdout).toHaveBeenCalledExactlyOnceWith(defaultModel);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([{ flags: [] }, { flags: ["--plain"] }])(
    "escapes control characters in text output (%j)",
    async ({ flags }) => {
      const model = "openai/café\u001b[2J\nforged";
      setFallback(model);
      await list(...flags);
      const output = [
        ...vi.mocked(defaultRuntime.log).mock.calls,
        ...vi.mocked(defaultRuntime.writeStdout).mock.calls,
      ]
        .flat()
        .join("\n");
      expect(output).toContain("openai/café\\nforged");
      expect(output).not.toContain("\u001b");
      await list("--json");
      expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ fallbacks: [model] }, 2);
    },
  );

  it.each([false, true])("preserves human output (empty: %s)", async (empty) => {
    if (empty) {
      mocks.loadModelsConfig.mockResolvedValue({});
    }
    await list();

    expect(vi.mocked(defaultRuntime.log).mock.calls).toEqual([
      [`${label} (${empty ? 0 : 1}):`],
      [empty ? "- none" : `- ${defaultModel}`],
    ]);
  });
});
