import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { resolveNodeServiceIdentityEnvironment } from "../daemon/constants.js";
import * as futureConfig from "../daemon/future-config-guard.js";
import * as launchdCurrent from "../daemon/launchd-current-service.js";
import * as launchdExec from "../daemon/launchd-exec.js";
import { buildLaunchAgentPlist } from "../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../daemon/launchd-plist.test-support.js";
import * as launchdSystem from "../daemon/launchd-system.js";
import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewaySupervisorLogPaths } from "../daemon/restart-logs.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { seedCompletedRuntimePinMigration } from "../daemon/test-helpers/service-audit-runtime-pin.js";
import { runGatewayServicesHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import * as exec from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as foreignJobs from "./doctor-foreign-launchd-jobs.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import * as repairPolicy from "./doctor-service-repair-policy.js";

vi.mock(import("../infra/tmp-openclaw-dir.js"), async (original) => ({
  ...(await original()),
  resolvePreferredOpenClawTmpDir: () => process.env.HOME!,
}));

const native = { loaded: true, failBootstrap: false, exec: vi.fn() };

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
let home: string;
let packageRoot: string;
let plist: string;
let original: string;
let restoreEnv: ReturnType<typeof captureEnv>;
const serviceEnv = () => ({ ...process.env, ...resolveNodeServiceIdentityEnvironment() });
const nodeOptions = [
  "node",
  "run",
  "--host",
  "node.example.test",
  "--port",
  "9443",
  "--tls",
  "--display-name",
  "Original node",
];
const isolatedEnvKeys = [
  "OPENCLAW_HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_UPDATE_IN_PROGRESS",
  "OPENCLAW_SERVICE_REPAIR_POLICY",
  "OPENCLAW_SUPERVISOR_MODE",
  "OPENCLAW_NIX_MODE",
];
const bootstrapped = () => native.exec.mock.calls.some(([args]) => args[0] === "bootstrap");

async function writeDefinition(entry = "index.js", customPolicy = false) {
  const env = serviceEnv();
  const { stdoutPath } = resolveGatewaySupervisorLogPaths(env);
  original = buildLaunchAgentPlist({
    label: "ai.openclaw.node",
    programArguments: [
      process.execPath,
      "--no-warnings",
      path.join(packageRoot, "dist", entry),
      ...nodeOptions,
    ],
    workingDirectory: packageRoot,
    environment: {
      HOME: home,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      ...resolveNodeServiceIdentityEnvironment(),
      CUSTOM_NODE_SETTING: "preserved",
    },
    stdoutPath,
    stderrPath: stdoutPath,
  });
  if (customPolicy) {
    original = original.replace(
      "<key>RunAtLoad</key>\n    <true/>",
      "<key>RunAtLoad</key>\n    <false/>",
    );
  }
  await fs.writeFile(plist, original);
}

beforeEach(async () => {
  vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(native.exec);
  vi.spyOn(launchdCurrent, "isCurrentProcessInsideLaunchdService").mockResolvedValue(false);
  vi.spyOn(launchdSystem, "inspectSystemLaunchDaemonOwnership").mockResolvedValue({
    status: "absent",
    serviceTarget: "system/ai.openclaw.node",
  });
  vi.spyOn(launchdSystem, "assertNoSystemLaunchDaemonOwnership").mockResolvedValue(undefined);
  vi.spyOn(futureConfig, "assertFutureConfigActionAllowed").mockResolvedValue(undefined);
  vi.spyOn(notes, "note").mockImplementation(() => {});
  vi.spyOn(foreignJobs, "noteMacForeignLaunchdJobs").mockResolvedValue(undefined);
  vi.spyOn(repairPolicy, "shouldManageGatewayService").mockResolvedValue(false);
  restoreEnv = captureEnv(["HOME", "OPENCLAW_STATE_DIR", ...isolatedEnvKeys]);
  home = await fs.realpath(await fs.mkdtemp(path.join(process.env.HOME!, "doctor-node-")));
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
  for (const key of isolatedEnvKeys) {
    delete process.env[key];
  }
  mockSystemAccountHome();
  // Private SQLite creation belongs to the host OS, before the launchd simulation.
  await seedCompletedRuntimePinMigration(process.env);
  const hostPlatform = process.platform;
  mockProcessPlatform("darwin");
  if (hostPlatform !== "darwin") {
    vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
      if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
        throw new Error(`Unexpected native command: ${file}`);
      }
      return decodeLaunchAgentPlistFixture(options.input, args[1]);
    });
  }
  packageRoot = path.join(home, "openclaw");
  plist = path.join(home, "Library", "LaunchAgents", "ai.openclaw.node.plist");
  await fs.mkdir(path.dirname(plist), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "// fixture launcher\n");
  native.loaded = true;
  native.failBootstrap = false;
  native.exec.mockReset().mockImplementation(async (args: string[]) => {
    const result = { code: 0, stdout: "", stderr: "", termination: "exit" };
    if (args[0] === "print") {
      return native.loaded
        ? { ...result, stdout: `${args[1]} = {\n\tstate = running\n\tpid = 567890\n}\n` }
        : { ...result, code: 113, stderr: "Could not find service" };
    }
    if (args[0] === "print-disabled") {
      return { ...result, stdout: '"ai.openclaw.node" => false' };
    }
    if (args[0] === "bootout" || args[0] === "unload") {
      native.loaded = false;
    }
    if (args[0] === "bootstrap") {
      if (native.failBootstrap) {
        native.failBootstrap = false;
        return { ...result, code: 5, stderr: "Fixture bootstrap failure" };
      }
      native.loaded = true;
    }
    return result;
  });
  vi.clearAllMocks();
  await writeDefinition();
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  restoreEnv.restore();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

function repair() {
  return runGatewayServicesHealth({
    runtime,
    prompter: createDoctorPrompter({ runtime, options: { repair: true } }),
    options: { repair: true },
    cfg: { gateway: { mode: "remote" } },
    cfgForPersistence: {},
    configResult: { cfg: {} },
    configPath: path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json"),
    sourceConfigValid: true,
  });
}

it.each([
  ["index.js", true],
  ["index.mjs", true],
  ["index.js", false],
] as const)("repairs %s and preserves activation (%s)", async (entry, loaded) => {
  native.loaded = loaded;
  await writeDefinition(entry);
  const before = await resolveNodeService().readCommand(process.env);
  await repair();
  expect(runtime.error).not.toHaveBeenCalled();
  const after = await resolveNodeService().readCommand(process.env);
  expect(after?.programArguments).toEqual([
    process.execPath,
    "--no-warnings",
    path.join(packageRoot, "openclaw.mjs"),
    ...nodeOptions,
  ]);
  expect(after?.workingDirectory).toBe(before?.workingDirectory);
  expect(after?.environment).toEqual(before?.environment);
  expect(native.loaded).toBe(loaded);
  expect(bootstrapped()).toBe(loaded);
});

it("preserves the previous definition when native activation fails", async () => {
  native.failBootstrap = true;
  await repair();
  expect(runtime.error).toHaveBeenCalled();
  expect(await fs.readFile(plist, "utf8")).toBe(original);
  expect(native.loaded).toBe(true);
});

it("leaves an absent node service alone", async () => {
  await fs.unlink(plist);
  native.loaded = false;
  await repair();
  expect(runtime.error).not.toHaveBeenCalled();
  expect(await resolveNodeService().readCommand(process.env)).toBeNull();
  expect(bootstrapped()).toBe(false);
});

it.each([
  ["update", "OPENCLAW_UPDATE_IN_PROGRESS", "1"],
  ["external", "OPENCLAW_SERVICE_REPAIR_POLICY", "external"],
  ["nix", "OPENCLAW_NIX_MODE", "1"],
  ["relocated-state", "OPENCLAW_STATE_DIR", "other-state"],
  ["custom-policy", undefined, undefined],
  ["custom-launcher", undefined, undefined],
] as const)("leaves %s ownership unchanged", async (owner, key, value) => {
  if (key) {
    process.env[key] = key === "OPENCLAW_STATE_DIR" ? path.join(home, value) : value;
  }
  if (owner === "custom-policy") {
    await writeDefinition("index.js", true);
  }
  if (owner === "custom-launcher") {
    original = original.replace("<key>CUSTOM_NODE_SETTING</key>", "<key>OPENCLAW_WRAPPER</key>");
    await fs.writeFile(plist, original);
  }
  await repair();
  expect(await fs.readFile(plist, "utf8")).toBe(original);
  expect(bootstrapped()).toBe(false);
});
