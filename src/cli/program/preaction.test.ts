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
  type CommandKey =
    | "status"
    | "doctor"
    | "completion"
    | "secrets"
    | "update-status"
    | "config-set"
    | "agents"
    | "configure"
    | "onboard"
    | "message-send";

  function buildProgram(keys: readonly CommandKey[]) {
    const enabled = new Set<CommandKey>(keys);
    const has = (key: CommandKey) => enabled.has(key);
    const program = new Command().name("openclaw");
    if (has("status")) {
      program.command("status").action(() => {});
    }
    if (has("doctor")) {
      program.command("doctor").action(() => {});
    }
    if (has("completion")) {
      program.command("completion").action(() => {});
    }
    if (has("secrets")) {
      program.command("secrets").action(() => {});
    }
    if (has("update-status")) {
      program
        .command("update")
        .command("status")
        .option("--json")
        .action(() => {});
    }
    if (has("config-set")) {
      const config = program.command("config");
      config
        .command("set")
        .argument("<path>")
        .argument("<value>")
        .option("--json")
        .action(() => {});
    }
    if (has("agents")) {
      program.command("agents").action(() => {});
    }
    if (has("configure")) {
      program.command("configure").action(() => {});
    }
    if (has("onboard")) {
      program.command("onboard").action(() => {});
    }
    if (has("message-send")) {
      program
        .command("message")
        .command("send")
        .option("--json")
        .action(() => {});
    }
    registerPreActionHooks(program, "9.9.9-test");
    return program;
  }

  async function runCommand(
    params: { parseArgv: string[]; processArgv?: string[] },
    program: Command,
  ) {
    process.argv = params.processArgv ?? [...params.parseArgv];
    await program.parseAsync(params.parseArgv, { from: "user" });
  }

  it("emits banner, resolves config, and enables verbose from --debug", async () => {
    const program = buildProgram(["status"]);
    await runCommand(
      {
        parseArgv: ["status"],
        processArgv: ["node", "openclaw", "status", "--debug"],
      },
      program,
    );

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
    const program = buildProgram(["message-send"]);
    await runCommand(
      {
        parseArgv: ["message", "send"],
        processArgv: ["node", "openclaw", "message", "send"],
      },
      program,
    );

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["message", "send"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin registry for configure command", async () => {
    const program = buildProgram(["configure"]);
    await runCommand(
      {
        parseArgv: ["configure"],
        processArgv: ["node", "openclaw", "configure"],
      },
      program,
    );

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("skips config guard for doctor command", async () => {
    const program = buildProgram(["doctor"]);
    await runCommand(
      {
        parseArgv: ["doctor"],
        processArgv: ["node", "openclaw", "doctor"],
      },
      program,
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("skips preaction work when argv indicates help/version", async () => {
    const program = buildProgram(["status"]);
    await runCommand(
      {
        parseArgv: ["status"],
        processArgv: ["node", "openclaw", "--version"],
      },
      program,
    );

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("hides banner when OPENCLAW_HIDE_BANNER is truthy", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";
    const program = buildProgram(["status"]);
    await runCommand(
      {
        parseArgv: ["status"],
        processArgv: ["node", "openclaw", "status"],
      },
      program,
    );

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses doctor stdout for any --json output command", async () => {
    const program = buildProgram(["message-send", "update-status"]);
    await runCommand(
      {
        parseArgv: ["message", "send", "--json"],
        processArgv: ["node", "openclaw", "message", "send", "--json"],
      },
      program,
    );

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["message", "send"],
      suppressDoctorStdout: true,
    });

    vi.clearAllMocks();

    await runCommand(
      {
        parseArgv: ["update", "status", "--json"],
        processArgv: ["node", "openclaw", "update", "status", "--json"],
      },
      program,
    );

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["update", "status"],
      suppressDoctorStdout: true,
    });
  });

  it("does not treat config set --json (strict-parse alias) as json output mode", async () => {
    const program = buildProgram(["config-set"]);
    await runCommand(
      {
        parseArgv: ["config", "set", "gateway.auth.mode", "{bad", "--json"],
        processArgv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "{bad", "--json"],
      },
      program,
    );

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["config", "set"],
    });
  });
});
