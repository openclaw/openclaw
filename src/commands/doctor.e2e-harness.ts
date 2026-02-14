import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

let originalIsTTY: boolean | undefined;
let originalStateDir: string | undefined;
let originalUpdateInProgress: string | undefined;
let tempStateDir: string | undefined;

function setStdinTty(value: boolean | undefined) {
  try {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  } catch {
    // ignore
  }
}

export const readConfigFileSnapshot: ReturnType<typeof vi.fn> = vi.fn();
export const confirm: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(true);
export const select: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue("node");
export const note: ReturnType<typeof vi.fn> = vi.fn();
export const writeConfigFile: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
export const resolveOpenClawPackageRoot: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(null);
export const runGatewayUpdate: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
  status: "skipped",
  mode: "unknown",
  steps: [],
  durationMs: 0,
});
export const migrateLegacyConfig: ReturnType<typeof vi.fn> = vi.fn((raw: unknown) => ({
  config: raw as Record<string, unknown>,
  changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
}));

export const runExec: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
  stdout: "",
  stderr: "",
});
export const runCommandWithTimeout: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
});

export const ensureAuthProfileStore: ReturnType<typeof vi.fn> = vi
  .fn()
  .mockReturnValue({ version: 1, profiles: {} });

export const legacyReadConfigFileSnapshot: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
  path: "/tmp/openclaw.json",
  exists: false,
  raw: null,
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
});
export const createConfigIO: ReturnType<typeof vi.fn> = vi.fn(() => ({
  readConfigFileSnapshot: legacyReadConfigFileSnapshot,
}));

export const findLegacyGatewayServices: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([]);
export const uninstallLegacyGatewayServices: ReturnType<typeof vi.fn> = vi
  .fn()
  .mockResolvedValue([]);
export const findExtraGatewayServices: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([]);
export const renderGatewayServiceCleanupHints: ReturnType<typeof vi.fn> = vi
  .fn()
  .mockReturnValue(["cleanup"]);
export const resolveGatewayProgramArguments: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
  programArguments: ["node", "cli", "gateway", "--port", "18789"],
});
export const serviceInstall: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
export const serviceIsLoaded: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(false);
export const serviceStop: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
export const serviceRestart: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
export const serviceUninstall: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined);
export const callGateway: ReturnType<typeof vi.fn> = vi
  .fn()
  .mockRejectedValue(new Error("gateway closed"));

vi.mock("@clack/prompts", () => ({
  confirm,
  intro: vi.fn(),
  note,
  outro: vi.fn(),
  select,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: () => ({ skills: [] }),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: () => ({ plugins: [], diagnostics: [] }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    CONFIG_PATH: "/tmp/openclaw.json",
    createConfigIO,
    readConfigFileSnapshot,
    writeConfigFile,
    migrateLegacyConfig,
  };
});

vi.mock("../daemon/legacy.js", () => ({
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    ...actual,
    callGateway,
  };
});

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot,
}));

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate,
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore,
  };
});

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: serviceInstall,
    uninstall: serviceUninstall,
    stop: serviceStop,
    restart: serviceRestart,
    isLoaded: serviceIsLoaded,
    readCommand: vi.fn(),
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
  }),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "000000", created: false }),
}));

vi.mock("../telegram/token.js", () => ({
  resolveTelegramToken: vi.fn(() => ({ token: "", source: "none" })),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: () => {},
    error: () => {},
    exit: () => {
      throw new Error("exit");
    },
  },
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    resolveUserPath: (value: string) => value,
    sleep: vi.fn(),
  };
});

vi.mock("./health.js", () => ({
  healthCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: Record<string, unknown>) => cfg,
  DEFAULT_WORKSPACE: "/tmp",
  guardCancel: (value: unknown) => value,
  printWizardHeader: vi.fn(),
  randomToken: vi.fn(() => "test-gateway-token"),
}));

vi.mock("./doctor-state-migrations.js", () => ({
  autoMigrateLegacyStateDir: vi.fn().mockResolvedValue({
    migrated: false,
    skipped: false,
    changes: [],
    warnings: [],
  }),
  detectLegacyStateMigrations: vi.fn().mockResolvedValue({
    targetAgentId: "main",
    targetMainKey: "main",
    targetScope: undefined,
    stateDir: "/tmp/state",
    oauthDir: "/tmp/oauth",
    sessions: {
      legacyDir: "/tmp/state/sessions",
      legacyStorePath: "/tmp/state/sessions/sessions.json",
      targetDir: "/tmp/state/agents/main/sessions",
      targetStorePath: "/tmp/state/agents/main/sessions/sessions.json",
      hasLegacy: false,
      legacyKeys: [],
    },
    agentDir: {
      legacyDir: "/tmp/state/agent",
      targetDir: "/tmp/state/agents/main/agent",
      hasLegacy: false,
    },
    whatsappAuth: {
      legacyDir: "/tmp/oauth",
      targetDir: "/tmp/oauth/whatsapp/default",
      hasLegacy: false,
    },
    preview: [],
  }),
  runLegacyStateMigrations: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
}));

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  select.mockReset().mockResolvedValue("node");
  note.mockClear();

  readConfigFileSnapshot.mockReset();
  writeConfigFile.mockReset().mockResolvedValue(undefined);
  resolveOpenClawPackageRoot.mockReset().mockResolvedValue(null);
  runGatewayUpdate.mockReset().mockResolvedValue({
    status: "skipped",
    mode: "unknown",
    steps: [],
    durationMs: 0,
  });
  legacyReadConfigFileSnapshot.mockReset().mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: false,
    raw: null,
    parsed: {},
    valid: true,
    config: {},
    issues: [],
    legacyIssues: [],
  });
  createConfigIO.mockReset().mockImplementation(() => ({
    readConfigFileSnapshot: legacyReadConfigFileSnapshot,
  }));
  runExec.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  runCommandWithTimeout.mockReset().mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });
  ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
  migrateLegacyConfig.mockReset().mockImplementation((raw: unknown) => ({
    config: raw as Record<string, unknown>,
    changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
  }));
  findLegacyGatewayServices.mockReset().mockResolvedValue([]);
  uninstallLegacyGatewayServices.mockReset().mockResolvedValue([]);
  findExtraGatewayServices.mockReset().mockResolvedValue([]);
  renderGatewayServiceCleanupHints.mockReset().mockReturnValue(["cleanup"]);
  resolveGatewayProgramArguments.mockReset().mockResolvedValue({
    programArguments: ["node", "cli", "gateway", "--port", "18789"],
  });
  serviceInstall.mockReset().mockResolvedValue(undefined);
  serviceIsLoaded.mockReset().mockResolvedValue(false);
  serviceStop.mockReset().mockResolvedValue(undefined);
  serviceRestart.mockReset().mockResolvedValue(undefined);
  serviceUninstall.mockReset().mockResolvedValue(undefined);
  callGateway.mockReset().mockRejectedValue(new Error("gateway closed"));

  originalIsTTY = process.stdin.isTTY;
  setStdinTty(true);
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  fs.mkdirSync(path.join(tempStateDir, "agents", "main", "sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tempStateDir, "credentials"), { recursive: true });
});

afterEach(() => {
  setStdinTty(originalIsTTY);
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (originalUpdateInProgress === undefined) {
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  } else {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
  }
  if (tempStateDir) {
    fs.rmSync(tempStateDir, { recursive: true, force: true });
    tempStateDir = undefined;
  }
});
