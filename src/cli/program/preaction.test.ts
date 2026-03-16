import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setVerboseMock = vi.fn();
const prepareCliExecutionMock = vi.fn(async () => {});

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

vi.mock("../cli-name.js", () => ({
  resolveCliName: () => "openclaw",
}));

vi.mock("./prepare-cli-execution.js", () => ({
  prepareCliExecution: prepareCliExecutionMock,
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
  let program: Command;
  let preActionHook:
    | ((thisCommand: Command, actionCommand: Command) => Promise<void> | void)
    | null = null;

  function buildProgram() {
    const program = new Command().name("openclaw");
    program.command("status").action(() => {});
    program
      .command("backup")
      .command("create")
      .option("--json")
      .action(() => {});
    program.command("doctor").action(() => {});
    program.command("completion").action(() => {});
    program.command("secrets").action(() => {});
    program.command("agents").action(() => {});
    program.command("configure").action(() => {});
    program.command("onboard").action(() => {});
    const channels = program.command("channels");
    channels.command("add").action(() => {});
    program
      .command("update")
      .command("status")
      .option("--json")
      .action(() => {});
    program
      .command("message")
      .command("send")
      .option("--json")
      .action(() => {});
    const config = program.command("config");
    config
      .command("set")
      .argument("<path>")
      .argument("<value>")
      .option("--json")
      .action(() => {});
    config
      .command("validate")
      .option("--json")
      .action(() => {});
    registerPreActionHooks(program, "9.9.9-test");
    return program;
  }

  function resolveActionCommand(parseArgv: string[]): Command {
    let current = program;
    for (const segment of parseArgv) {
      const next = current.commands.find((command) => command.name() === segment);
      if (!next) {
        break;
      }
      current = next;
    }
    return current;
  }

  async function runPreAction(params: { parseArgv: string[]; processArgv?: string[] }) {
    process.argv = params.processArgv ?? [...params.parseArgv];
    const actionCommand = resolveActionCommand(params.parseArgv);
    if (!preActionHook) {
      throw new Error("missing preAction hook");
    }
    await preActionHook(program, actionCommand);
  }

  it("handles debug mode and plugin-required command preaction", async () => {
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--debug"],
    });

    expect(setVerboseMock).toHaveBeenCalledWith(true);
    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "status", "--debug"],
      bannerVersion: "9.9.9-test",
      hideBanner: false,
      runtime: runtimeMock,
      commandPath: ["status"],
      loadPlugins: true,
      pluginScope: "channels",
      suppressDoctorStdout: false,
    });
    expect(process.title).toBe("openclaw-status");

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["message", "send"],
      processArgv: ["node", "openclaw", "message", "send"],
    });

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "message", "send"],
      bannerVersion: "9.9.9-test",
      hideBanner: false,
      runtime: runtimeMock,
      commandPath: ["message", "send"],
      loadPlugins: true,
      pluginScope: "all",
      suppressDoctorStdout: false,
    });
  });

  it("keeps setup alias and channels add manifest-first", async () => {
    await runPreAction({
      parseArgv: ["onboard"],
      processArgv: ["node", "openclaw", "onboard"],
    });

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "onboard"],
      bannerVersion: "9.9.9-test",
      hideBanner: false,
      runtime: runtimeMock,
      commandPath: ["onboard"],
      loadPlugins: false,
      pluginScope: undefined,
      suppressDoctorStdout: false,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["channels", "add"],
      processArgv: ["node", "openclaw", "channels", "add"],
    });

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "channels", "add"],
      bannerVersion: "9.9.9-test",
      hideBanner: false,
      runtime: runtimeMock,
      commandPath: ["channels", "add"],
      loadPlugins: false,
      pluginScope: undefined,
      suppressDoctorStdout: false,
    });
  });

  it("skips help/version preaction and respects banner opt-out", async () => {
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "--version"],
    });

    expect(prepareCliExecutionMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status"],
    });

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "status"],
      bannerVersion: "9.9.9-test",
      hideBanner: true,
      runtime: runtimeMock,
      commandPath: ["status"],
      loadPlugins: true,
      pluginScope: "channels",
      suppressDoctorStdout: false,
    });
  });

  it("applies --json stdout suppression only for explicit JSON output commands", async () => {
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--json"],
    });

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "status", "--json"],
      bannerVersion: "9.9.9-test",
      hideBanner: false,
      runtime: runtimeMock,
      commandPath: ["status"],
      loadPlugins: false,
      pluginScope: undefined,
      suppressDoctorStdout: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["update", "status", "--json"],
      processArgv: ["node", "openclaw", "update", "status", "--json"],
    });

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "update", "status", "--json"],
      bannerVersion: "9.9.9-test",
      hideBanner: true,
      runtime: runtimeMock,
      commandPath: ["update", "status"],
      loadPlugins: false,
      pluginScope: undefined,
      suppressDoctorStdout: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["config", "set", "gateway.auth.mode", "{bad", "--json"],
      processArgv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "{bad", "--json"],
    });

    expect(prepareCliExecutionMock).toHaveBeenCalledWith({
      argv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "{bad", "--json"],
      bannerVersion: "9.9.9-test",
      hideBanner: false,
      runtime: runtimeMock,
      commandPath: ["config", "set"],
      loadPlugins: false,
      pluginScope: undefined,
      suppressDoctorStdout: false,
    });
  });

  it("bypasses config guard for config validate", async () => {
    await runPreAction({
      parseArgv: ["config", "validate"],
      processArgv: ["node", "openclaw", "config", "validate"],
    });

    expect(prepareCliExecutionMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config validate when root option values are present", async () => {
    await runPreAction({
      parseArgv: ["config", "validate"],
      processArgv: ["node", "openclaw", "--profile", "work", "config", "validate"],
    });

    expect(prepareCliExecutionMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for backup create", async () => {
    await runPreAction({
      parseArgv: ["backup", "create"],
      processArgv: ["node", "openclaw", "backup", "create", "--json"],
    });

    expect(prepareCliExecutionMock).not.toHaveBeenCalled();
  });

  beforeAll(() => {
    program = buildProgram();
    const hooks = (
      program as unknown as {
        _lifeCycleHooks?: {
          preAction?: Array<(thisCommand: Command, actionCommand: Command) => Promise<void> | void>;
        };
      }
    )._lifeCycleHooks?.preAction;
    preActionHook = hooks?.[0] ?? null;
  });
});
