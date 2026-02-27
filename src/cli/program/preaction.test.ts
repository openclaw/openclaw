import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setVerboseMock = vi.fn();
const emitCliBannerMock = vi.fn();
const ensureConfigReadyMock = vi.fn(async () => {});
const ensurePluginRegistryLoadedMock = vi.fn();

const runtimeMock = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../globals.js", () => ({
  setVerbose: setVerboseMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("../banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../cli-name.js", () => ({
  resolveCliName: () => "openclaw",
}));

vi.mock("./config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

let registerPreActionHooks: typeof import("./preaction.js").registerPreActionHooks;
let originalProcessArgv: string[];
let originalProcessTitle: string;
let originalNodeNoWarnings: string | undefined;
let originalHideBanner: string | undefined;

beforeAll(async () => {
  ({ registerPreActionHooks } = await import("./preaction.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  originalProcessArgv = [...process.argv];
  originalProcessTitle = process.title;
  originalNodeNoWarnings = process.env.NODE_NO_WARNINGS;
  originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
  delete process.env.NODE_NO_WARNINGS;
  delete process.env.OPENCLAW_HIDE_BANNER;
});

afterEach(() => {
  process.argv = originalProcessArgv;
  process.title = originalProcessTitle;
  if (originalNodeNoWarnings === undefined) {
    delete process.env.NODE_NO_WARNINGS;
  } else {
    process.env.NODE_NO_WARNINGS = originalNodeNoWarnings;
  }
  if (originalHideBanner === undefined) {
    delete process.env.OPENCLAW_HIDE_BANNER;
  } else {
    process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
  }
});

describe("registerPreActionHooks", () => {
  function buildProgram() {
    const program = new Command().name("openclaw");
    program.command("status").action(async () => {});
    program.command("doctor").action(async () => {});
    program.command("completion").action(async () => {});
    program.command("update").action(async () => {});
    program.command("channels").action(async () => {});
    program.command("directory").action(async () => {});
    program.command("configure").action(async () => {});
    program.command("onboard").action(async () => {});
    program
      .command("message")
      .command("send")
      .action(async () => {});
    registerPreActionHooks(program, "9.9.9-test");
    return program;
  }

  async function runCommand(params: { parseArgv: string[]; processArgv?: string[] }) {
    const program = buildProgram();
    process.argv = params.processArgv ?? [...params.parseArgv];
    await program.parseAsync(params.parseArgv, { from: "user" });
  }

  it("emits banner, resolves config, and enables verbose from --debug", async () => {
    await runCommand({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--debug"],
    });

    expect(emitCliBannerMock).toHaveBeenCalledWith("9.9.9-test");
    expect(setVerboseMock).toHaveBeenCalledWith(true);
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(process.title).toBe("openclaw-status");
  });

  it("loads plugin registry for plugin-required commands", async () => {
    await runCommand({
      parseArgv: ["message", "send"],
      processArgv: ["node", "openclaw", "message", "send"],
    });

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["message", "send"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin registry for configure command", async () => {
    await runCommand({
      parseArgv: ["configure"],
      processArgv: ["node", "openclaw", "configure"],
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin registry for onboard command", async () => {
    await runCommand({
      parseArgv: ["onboard"],
      processArgv: ["node", "openclaw", "onboard"],
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("skips config guard for doctor and completion commands", async () => {
    await runCommand({
      parseArgv: ["doctor"],
      processArgv: ["node", "openclaw", "doctor"],
    });
    await runCommand({
      parseArgv: ["completion"],
      processArgv: ["node", "openclaw", "completion"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("skips preaction work when argv indicates help/version", async () => {
    await runCommand({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "--version"],
    });

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("hides banner when OPENCLAW_HIDE_BANNER is truthy", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";
    await runCommand({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status"],
    });

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).toHaveBeenCalledTimes(1);
  });
});
