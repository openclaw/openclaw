import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../daemon/test-helpers/service-audit-mocks.js";
import { applyCliProfileEnv } from "../cli/profile.js";
import { runDoctorLintCli } from "../commands/doctor-lint.js";
import { renderTriagePrompt } from "../commands/triage-prompt.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  execSystemctlMock,
  execSystemctlUserMock,
  resetServiceAuditMocks,
  resolveNodeRuntimeInfoMock,
} from "../daemon/test-helpers/service-audit-fixtures.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const checkId = "core/doctor/gateway-services/platform-notes";

function detect(cfg: OpenClawConfig = {}) {
  const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === checkId);
  expect(check).toBeDefined();
  return check!.detect({ mode: "lint", runtime, cfg });
}

const legacyUnit = "[Service]\nKillMode=control-group\n";
const killModeWarning = {
  severity: "warning",
  message: expect.stringContaining("KillMode=mixed"),
};

function effectiveUnit(mode: string, loadState: string) {
  execSystemctlUserMock.mockResolvedValue({
    stdout: `KillMode=${mode}\nLoadState=${loadState}\n`,
    stderr: "",
    code: 0,
    termination: "exit",
  });
}

const runtime = { log() {}, error() {}, exit() {} };
let home: string;
let unitPath: string;

beforeEach(async () => {
  resetServiceAuditMocks();
  const account = os.userInfo();
  home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-platform-"));
  vi.spyOn(os, "userInfo").mockReturnValue({ ...account, homedir: home });
  mockProcessPlatform("linux");
  for (const key of ["HOME", "STATE_DIR", "CONFIG_PATH", "PROFILE", "SYSTEMD_UNIT"]) {
    vi.stubEnv(`OPENCLAW_${key}`, undefined);
  }
  vi.stubEnv("HOME", home);
  unitPath = path.join(home, ".config", "systemd", "user", "openclaw-gateway.service");
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

it("reports the host shutdown cap without a Gateway reinstall hint", async () => {
  await fs.writeFile(unitPath, "[Service]\nKillMode=mixed\n");
  execSystemctlUserMock.mockResolvedValue({
    stdout:
      "LoadState=loaded\nKillMode=mixed\nControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service\n",
    stderr: "",
    code: 0,
    termination: "exit",
  });
  execSystemctlMock.mockResolvedValue({
    stdout: "LoadState=loaded\nTimeoutStopUSec=5s\n",
    stderr: "",
    code: 0,
    termination: "exit",
  });
  const findings = await detect();
  expect(findings).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("Gateway drain to 5s"),
    }),
  ]);
  expect(findings[0]).not.toHaveProperty("fixHint");
});

it.each(["legacy", "profile"])("triages %s read-only", async (scenario) => {
  const profile = scenario === "profile";
  if (profile) {
    const profileEnv = { ...process.env };
    applyCliProfileEnv({ profile: "upgrade-proof", env: profileEnv, homedir: () => home });
    for (const name of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
      vi.stubEnv(name, profileEnv[name]);
    }
    effectiveUnit("control-group", "loaded");
  }
  const file = profile
    ? path.join(path.dirname(unitPath), "openclaw-gateway-upgrade-proof.service")
    : unitPath;
  const unit = profile ? "[Service]\nKillMode=mixed\n" : legacyUnit;
  await fs.writeFile(file, unit);
  expect(isDefaultInstallIdentity()).toBe(true);
  const findings = await detect(profile ? {} : { gateway: { mode: "local" } });
  expect(findings).toMatchObject([
    {
      ...killModeWarning,
      fixHint: expect.stringContaining("gateway install --force"),
    },
  ]);
  const prompt = renderTriagePrompt({
    findings,
    bundle: { kind: "skipped" },
    redaction: {
      env: process.env,
      stateDir: path.join(home, profile ? ".openclaw-upgrade-proof" : ".openclaw"),
    },
  });
  for (const text of [
    "KillMode=mixed",
    "drop-ins separately",
    profile
      ? "openclaw --profile upgrade-proof gateway install --force"
      : "gateway install --force",
  ]) {
    expect(prompt).toContain(text);
  }
  expect(prompt).not.toContain(home);
  expect(await fs.readFile(file, "utf8")).toBe(unit);
  if (profile) {
    expect(execSystemctlUserMock.mock.calls[0]?.[1]).toContain(path.basename(file));
    expect(resolveNodeRuntimeInfoMock).not.toHaveBeenCalled();
  }
});

it.each([
  ["repaired", "mixed", "loaded"],
  ["masked", "control-group", "masked"],
  ["remote", "", ""],
  ["nix", "", ""],
  ["relocated", "", ""],
])("does not propose repairs for %s installations", async (scope, mode, loadState) => {
  await fs.writeFile(unitPath, legacyUnit);
  if (mode) {
    effectiveUnit(mode, loadState);
  }
  if (scope === "nix") {
    vi.stubEnv("OPENCLAW_NIX_MODE", "1");
  }
  if (scope === "relocated") {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "other-state"));
  }
  expect(await detect(scope === "remote" ? { gateway: { mode: "remote" } } : {})).toEqual([]);
  expect(resolveNodeRuntimeInfoMock).not.toHaveBeenCalled();
  if (!mode) {
    expect(execSystemctlUserMock).not.toHaveBeenCalled();
  }
});
it("reports the unit through Doctor JSON while keeping warnings nonblocking at the updater error threshold", async () => {
  await fs.writeFile(unitPath, legacyUnit);
  const stateDir = path.join(home, ".openclaw");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
  );
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const lint = (severityMin?: "error") =>
    runDoctorLintCli(runtime, { json: true, onlyIds: [checkId], severityMin });
  expect(await lint()).toBe(1);
  expect(JSON.parse(output).findings).toEqual([expect.objectContaining(killModeWarning)]);
  output = "";
  expect(await lint("error")).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ ok: true });
});
