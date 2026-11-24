import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import { parseUpdateAdmissionVerdict } from "../../infra/update-run-schema.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { updateAdmitCommand } from "./update-command-admit.js";
import { snapshotUpdateFixtureFiles } from "./update-command-filesystem-snapshot.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const previousExitCode = process.exitCode;
let home: string;
let configPath: string;
let contextPath: string;
let stdout: string;

beforeEach(() => {
  process.exitCode = undefined;
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  home = dirs.make("workshop-admission-");
  const root = path.join(home, "prefix", "lib", "node_modules", "openclaw");
  const stateDir = path.join(home, "profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(stateDir);
  writeFixtureJsonSync(path.join(root, "package.json"), { name: "openclaw", version: "2026.10.9" });
  configPath = path.join(stateDir, "openclaw.json");
  contextPath = path.join(home, "context.json");
  const context: UpdateAdmissionContext = {
    protocol: 1,
    installation: {
      root,
      canonicalRoot: fs.realpathSync(root),
      version: "2026.10.9",
      installKind: "package",
      packageManager: "npm",
    },
    target: { spec: "openclaw@latest", version: null, source: "registry", channel: "stable" },
    request: { yes: true, noRestart: true, acceptCapabilities: false, json: true },
    run: { id: "workshop-admission-fixture" },
    supervisor: { version: "2026.10.9", host: "fixture", pid: process.pid },
  };
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_OAUTH_DIR: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  })) {
    vi.stubEnv(key, value);
  }
  fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Admission previews only core Doctor migrations, so core owns the Workshop settings move.
it.each([
  ["alone", {}],
  // A 2026.10.9 base config also carries the retired heartbeat key core projects.
  ["with a retired heartbeat", { agents: { defaults: { heartbeat: { every: "0m" } } } }],
])(
  "admits retired skills.workshop settings %s for candidate Doctor without rewriting config",
  async (_name, extra) => {
    writeFixtureJsonSync(configPath, {
      ...extra,
      skills: { workshop: { autonomous: { mode: "off" }, maxSkillBytes: 8000 } },
    });
    const before = snapshotUpdateFixtureFiles(home);

    await updateAdmitCommand(contextPath);

    expect(process.exitCode).toBe(0);
    expect(parseUpdateAdmissionVerdict(JSON.parse(stdout))).toMatchObject({
      verdict: "admit",
      reasons: [],
      facts: { checks: expect.arrayContaining([{ name: "config", status: "warn" }]) },
    });
    expect(snapshotUpdateFixtureFiles(home)).toEqual(before);
  },
);
