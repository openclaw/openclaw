import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../../logging/state.js";
import { registerPreActionHooks } from "./preaction.js";

const { ensureConfigReadyMock, ensurePluginRegistryLoadedMock, emitCliBannerMock } = vi.hoisted(
  () => ({
    ensureConfigReadyMock: vi.fn(async () => {}),
    ensurePluginRegistryLoadedMock: vi.fn(async () => {}),
    emitCliBannerMock: vi.fn(),
  }),
);
vi.mock("./config-guard.js", () => ({ ensureConfigReady: ensureConfigReadyMock }));
vi.mock("../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));
vi.mock("../banner.js", () => ({ emitCliBanner: emitCliBannerMock }));
vi.mock("../../globals.js", () => ({ setVerbose: vi.fn() }));
let argv: string[];
let title: string;
let forceStderr: boolean;
let earlyRouting: boolean | null;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_NO_WARNINGS", undefined);
  argv = process.argv;
  title = process.title;
  forceStderr = loggingState.forceConsoleToStderr;
  earlyRouting = loggingState.earlyConsoleRoutingRestore;
});
afterEach(() => {
  process.argv = argv;
  process.title = title;
  loggingState.forceConsoleToStderr = forceStderr;
  loggingState.earlyConsoleRoutingRestore = earlyRouting;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("native update capability startup", () => {
  it("does not infer cold startup from an unparsed check token", async () => {
    const { resolveCliStartupPolicy } = await import("../command-startup-policy.js");
    expect(
      resolveCliStartupPolicy({
        argv: ["node", "openclaw", "gateway", "install", "--update-executor", "check"],
        commandPath: ["gateway", "install"],
        jsonOutputMode: false,
        env: {},
      }),
    ).toMatchObject({ skipConfigGuard: false, hideBanner: false });
  });

  it("keeps a parsed native capability check cold", async () => {
    const { runGatewayServiceUpdateCommand } = await import("../daemon-cli/update-executor.js");
    const parseProgram = new Command().name("openclaw");
    const operation = vi.fn();
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    parseProgram
      .command("gateway")
      .command("install")
      .option("--update-executor <mode>")
      .action(async (opts) =>
        runGatewayServiceUpdateCommand(opts.updateExecutor, "install", operation),
      );
    registerPreActionHooks(parseProgram, "9.9.9-test");
    process.argv = ["node", "openclaw", "gateway", "install", "--update-executor", "check"];
    await parseProgram.parseAsync(process.argv);
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(
      expect.objectContaining({ retainedOwnerBinding: true }),
    );
    output.mockRestore();
  });

  it.each([
    ["gateway", "install", ["--note", "--update-executor", "--update-executor", "run"]],
    ["gateway", "install", ["--update-executor", "check", "extra"]],
    ["other", "install", ["--update-executor", "check"]],
  ])("keeps startup guarded for %s %s %j", async (parent, action, args) => {
    const parseProgram = new Command().name("openclaw");
    parseProgram
      .command(parent)
      .command(action)
      .argument("[extra]")
      .option("--update-executor <mode>")
      .option("--note <text>")
      .action(() => {});
    registerPreActionHooks(parseProgram, "9.9.9-test");
    process.argv = ["node", "openclaw", parent, action, ...args];
    await parseProgram.parseAsync(process.argv);
    expect(ensureConfigReadyMock).toHaveBeenCalled();
  });
});
