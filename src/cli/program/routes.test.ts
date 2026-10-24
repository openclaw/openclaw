import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
} from "../command-execution-startup.js";
import { tryRouteCli } from "../route.js";
import { expectNoCalls } from "./program.test-helpers.js";

const modelsStatusCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const statusJsonCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runDaemonStatusMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

vi.mock("../../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: modelsStatusCommandMock,
}));

vi.mock("../../commands/status-json.js", () => ({
  statusJsonCommand: statusJsonCommandMock,
}));

// mock-isolation: Route dispatch stops at the daemon entrypoint without opening service state.
vi.mock("../daemon-cli/status.js", () => ({
  runDaemonStatus: runDaemonStatusMock,
}));

function routeArgv(args = ""): string[] {
  return ["node", "openclaw", ...(args ? args.split(" ") : [])];
}

describe("program routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function expectRunFalse(argv: string[]) {
    await expect(tryRouteCli(argv)).resolves.toBe(false);
    expectNoCalls(
      vi.mocked(applyCliExecutionStartupPresentation),
      vi.mocked(ensureCliExecutionBootstrap),
    );
  }

  async function expectRouted(args: string) {
    await expect(tryRouteCli(routeArgv(args))).resolves.toBe(true);
  }

  it.each([
    ["plugins", "list", "--wat"],
    ["gateway", "status", "--ssh-identity", "~/.ssh/id_test"],
    ["sessions", "--store", ""],
    ["models", "--", "--status-json"],
  ])("defers unsupported arguments %j to Commander", async (...args) => {
    await expectRunFalse(["node", "openclaw", ...args]);
    expect(modelsStatusCommandMock).not.toHaveBeenCalled();
  });

  it("routes local runtime intent with config and plugin startup disabled", async () => {
    await expectRouted("gateway status --runtime-intent-only --json");
    expect(runDaemonStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeIntentOnly: true, json: true }),
    );
    expect(ensureCliExecutionBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        startupPolicy: expect.objectContaining({ skipConfigGuard: true, loadPlugins: false }),
      }),
    );
  });

  it("routes status --json through the lean JSON command", async () => {
    await expectRouted("status --json --deep --usage --agent beta --timeout 5000");
    expect(statusJsonCommandMock).toHaveBeenCalledWith(
      { deep: true, all: false, usage: true, agent: "beta", timeoutMs: 5000 },
      defaultRuntime,
    );
  });

  it("accepts negative-number probe profile values", async () => {
    await expectRouted(
      "models status --probe-provider openai --probe-timeout 5000 --probe-concurrency 2 " +
        "--probe-max-tokens 64 --probe-profile -1 --agent default",
    );
    expect(modelsStatusCommandMock).toHaveBeenCalledWith(
      {
        probeProvider: "openai",
        probeTimeout: "5000",
        probeConcurrency: "2",
        probeMaxTokens: "64",
        probeProfile: "-1",
        agent: "default",
        json: false,
        plain: false,
        check: false,
        probe: false,
      },
      defaultRuntime,
    );
  });
});
