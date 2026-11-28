import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  SystemdServiceAccountRefusalError,
  type SystemdServiceAccountMismatch,
} from "../../daemon/service-inspection-error.js";
import type { SystemdServiceReadTarget } from "../../daemon/service-types.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import {
  parseUpdateAdmissionVerdict,
  type UpdateAdmissionVerdict,
} from "../../infra/update-run-schema.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { updateAdmitCommand } from "./update-command-admit.js";
import { snapshotUpdateFixtureFiles } from "./update-command-filesystem-snapshot.test-support.js";

// Unit selection and the bus read have their own owner tests; these tests feed
// their observed results to admission and check the verdict a driver receives.
const systemd = vi.hoisted(() => ({
  findScope:
    vi.fn<
      (
        env: NodeJS.ProcessEnv,
        options?: { onAccountMismatch?: (mismatch: SystemdServiceAccountMismatch) => void },
      ) => Promise<SystemdServiceReadTarget | null>
    >(),
  readCommand: vi.fn<(env: NodeJS.ProcessEnv) => Promise<unknown>>(),
  readAsRoot: vi.fn<() => Promise<unknown>>(),
  readAccount: vi.fn<(user: string) => Promise<unknown>>(),
  runuser: vi.fn<() => Promise<string | undefined>>(),
  entry: vi.fn<() => Promise<string | undefined>>(),
  candidateRoot: undefined as string | undefined,
}));
vi.mock("../../infra/openclaw-root.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/openclaw-root.js")>();
  return {
    ...actual,
    resolveOpenClawPackageRootSync: (
      options: Parameters<typeof actual.resolveOpenClawPackageRootSync>[0],
    ) => systemd.candidateRoot ?? actual.resolveOpenClawPackageRootSync(options),
  };
});
vi.mock("../../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: systemd.findScope,
}));
vi.mock("../../daemon/systemd-service-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceExecStart: systemd.readCommand,
  readSystemdServiceExecStartAsRoot: systemd.readAsRoot,
}));
vi.mock("../../daemon/systemd-state-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-state-identity.js")>()),
  readSystemdAccount: systemd.readAccount,
}));
// The switch path finds runuser by root-owned paths; tests put a stand-in for the account's
// process there, so everything it returns is what a service account could return.
vi.mock("../../daemon/systemd-service-account-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-service-account-command.js")>()),
  findRootOwnedRunuser: systemd.runuser,
}));
vi.mock("../../daemon/gateway-entrypoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/gateway-entrypoint.js")>()),
  resolveGatewayInstallEntrypoint: systemd.entry,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid")!;
const setEuid = (uid: number) =>
  Object.defineProperty(process, "geteuid", { configurable: true, value: () => uid });
const previousExitCode = process.exitCode;
const candidateVersion = (
  JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
let home: string;
let root: string;
let stateDir: string;
let contextPath: string;
let stdout: string;
const unit: SystemdServiceReadTarget = {
  scope: "system",
  unitName: "openclaw-gateway.service",
  unitPath: "/etc/systemd/system/openclaw-gateway.service",
};

const account = (username: string, uid: number) => ({
  username,
  uid,
  gid: uid,
  homedir: `/home/${username}`,
  shell: "/bin/sh",
});
const otherInstall = ["/usr/bin/node", "/opt/other/openclaw/dist/index.js"];
let serviceHome: string;
const serviceCommand = (overrides: Record<string, unknown> = {}) => ({
  programArguments: ["/usr/bin/node", path.join(root, "dist", "index.js"), "gateway"],
  environment: {
    HOME: serviceHome,
    OPENCLAW_STATE_DIR: "/var/lib/openclaw/.openclaw",
    OPENAI_API_KEY: "unit-only-value",
  },
  sourcePath: unit.unitPath,
  ...overrides,
});

function mismatch(overrides: Partial<SystemdServiceAccountMismatch> = {}) {
  return new SystemdServiceAccountRefusalError({
    unitName: unit.unitName,
    unitPath: unit.unitPath,
    serviceUser: "openclaw",
    programArguments: ["/usr/bin/node", path.join(root, "dist", "index.js"), "gateway"],
    workingDirectory: "",
    selectors: { HOME: "/var/lib/openclaw", OPENCLAW_STATE_DIR: "/var/lib/openclaw/.openclaw" },
    selectorsIncomplete: false,
    ...overrides,
  });
}

async function admit(): Promise<UpdateAdmissionVerdict> {
  await updateAdmitCommand(contextPath);
  const verdict = parseUpdateAdmissionVerdict(JSON.parse(stdout));
  expect(verdict).not.toBeNull();
  return verdict!;
}

beforeEach(() => {
  process.exitCode = undefined;
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The installed updater's admission deadline runs from when it started this process.
  vi.spyOn(process, "uptime").mockReturnValue(1);
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.spyOn(os, "userInfo").mockReturnValue(account("root", 0));
  home = dirs.make("service-account-admission-");
  root = path.join(home, "prefix", "lib", "node_modules", "openclaw");
  stateDir = path.join(home, "root-state");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "index.js"), "");
  fs.mkdirSync(stateDir);
  writeFixtureJsonSync(path.join(root, "package.json"), {
    name: "openclaw",
    version: "2026.11.10",
  });
  // Invalid on purpose: admission must refuse on the service account before reading this state.
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{ not json");
  contextPath = path.join(home, "context.json");
  const context: UpdateAdmissionContext = {
    protocol: 1,
    installation: {
      root,
      canonicalRoot: fs.realpathSync(root),
      version: "2026.11.10",
      installKind: "package",
      packageManager: "npm",
    },
    target: { spec: "openclaw@latest", version: null, source: "registry", channel: "stable" },
    request: { yes: true, noRestart: false, acceptCapabilities: false, json: false },
    run: { id: "service-account-admission-fixture" },
    supervisor: { version: "2026.11.10", host: "fixture", pid: process.pid },
  };
  fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    vi.stubEnv(key, value);
  }
  systemd.findScope.mockReset().mockResolvedValue(unit);
  systemd.readCommand.mockReset().mockRejectedValue(mismatch());
  // The account's HOME, which it owns and can write; tests run as that account.
  serviceHome = dirs.make("service-account-home-");
  if (process.getuid?.() === 0) {
    // A root test runner stands in for an account with UID 1001, which owns its HOME.
    fs.chownSync(serviceHome, 1001, process.getgid?.() ?? 0);
  }
  // Root by default; refusal cases below remove one requirement for switching accounts.
  setEuid(0);
  systemd.readAccount.mockReset().mockResolvedValue({
    // A root test runner may hand files to any account; others only to themselves.
    uid: process.getuid?.() || 1001,
    gid: process.getgid?.() ?? 0,
    home: "/var/lib/openclaw",
  });
  systemd.runuser.mockReset().mockResolvedValue(undefined);
  systemd.readAsRoot.mockReset().mockResolvedValue(serviceCommand());
  systemd.entry.mockReset().mockResolvedValue(path.join(root, "dist", "index.js"));
  systemd.candidateRoot = undefined;
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "geteuid", geteuid);
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("candidate admission for a system unit run by another account", () => {
  it("refuses before reading this account's state and names the documented procedure", async () => {
    const before = snapshotUpdateFixtureFiles(home);

    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.verdict).toBe("refuse");
    const message = `Gateway service openclaw-gateway.service runs as openclaw, but this update runs as root and would back up and check root's own state instead of the service's.`;
    expect(verdict.facts.checks).toEqual([
      { name: "managed-service-account", status: "refuse", detail: message },
    ]);
    expect(verdict.reasons).toEqual([
      {
        code: "service-account-mismatch",
        message,
        nextAction:
          "Automatic update as the service account is not possible: no root-owned runuser was found. " +
          "Nothing was changed: the package, the service state and the running Gateway are as they were. " +
          "Update this system service by hand (https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account). " +
          "First make a verified backup of its state as openclaw: sudo -u openclaw env HOME=/var/lib/openclaw OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw openclaw backup create --verify --output /var/lib/openclaw. " +
          `Then run sudo npm install -g openclaw@${candidateVersion} --allow-scripts=openclaw and sudo systemctl restart openclaw-gateway.service.`,
      },
    ]);
    expect(JSON.stringify(verdict.reasons)).not.toMatch(/doctor|update repair|stop --force/u);
    // Published drivers print at most 200 characters of a failing check.
    expect(message.length).toBeLessThanOrEqual(200);
    expect(snapshotUpdateFixtureFiles(home)).toEqual(before);
  });

  it("refuses when this account selects the service's own state", async () => {
    const selectors = { HOME: "/var/lib/openclaw", OPENCLAW_STATE_DIR: stateDir };
    systemd.readCommand.mockRejectedValue(mismatch({ selectors }));
    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.reasons[0]?.message).toContain(
      "this update runs as root and would write that service's state as root.",
    );
    // Drivers print this with their state path rewritten, as redactSupportString does; the
    // printed commands must still name the service's state in an operator's shell.
    const shown = redactSupportString(verdict.reasons[0]?.nextAction ?? "", {
      env: {},
      stateDir,
    });
    expect(shown).not.toContain("$OPENCLAW_STATE_DIR");
    const chown = /back to openclaw first: sudo find (\S+) -xdev -user 0 -exec chown openclaw /u;
    const backup = / OPENCLAW_STATE_DIR=(\S+) openclaw backup create --verify /u;
    for (const word of [chown.exec(shown)?.[1], backup.exec(shown)?.[1]]) {
      expect(execFileSync("sh", ["-c", `printf %s ${word}`], { encoding: "utf8" })).toBe(stateDir);
    }
  });

  it.each([
    {
      name: "keeps the reinstall with the owning account and package manager",
      setup: () => {
        vi.spyOn(os, "userInfo").mockReturnValue(account("admin", 1000));
        const context = JSON.parse(fs.readFileSync(contextPath, "utf8")) as UpdateAdmissionContext;
        context.installation.packageManager = "pnpm";
        fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
      },
      shown: [
        "this update runs as admin",
        `Then run pnpm add -g --allow-build=openclaw openclaw@${candidateVersion} and sudo systemctl restart`,
      ],
    },
    {
      name: "names a numeric account the way sudo accepts it",
      setup: () => systemd.readCommand.mockRejectedValue(mismatch({ serviceUser: "1001" })),
      shown: [
        "runs as UID 1001, but",
        "its state as UID 1001: sudo -u '#1001' env HOME=/var/lib/openclaw",
      ],
    },
    {
      name: "asks for the unit's selectors when an environment file sets them",
      setup: () => systemd.readCommand.mockRejectedValue(mismatch({ selectorsIncomplete: true })),
      shown: [
        "sudo -u openclaw env <the unit's HOME, OPENCLAW_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH and OPENCLAW_PROFILE> openclaw backup create --verify --output <directory>",
      ],
    },
    {
      name: "derives the backup selectors from a --profile in ExecStart",
      setup: () =>
        systemd.readCommand.mockRejectedValue(
          mismatch({
            programArguments: [...mismatch().mismatch.programArguments, "--profile", "prod"],
            selectors: { HOME: "/var/lib/openclaw" },
          }),
        ),
      shown: [" OPENCLAW_PROFILE=prod ", " OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw-prod "],
    },
    {
      // Discovery skips a custom-named unit it cannot read and reports why.
      name: "refuses for a custom-named unit that discovery skipped for its account",
      setup: () =>
        systemd.findScope.mockImplementation(async (_env, options) => {
          options?.onAccountMismatch?.(mismatch({ unitName: "company-gateway.service" }).mismatch);
          return null;
        }),
      shown: [
        "Gateway service company-gateway.service runs as openclaw",
        "sudo systemctl restart company-gateway.service.",
      ],
    },
  ])("$name", async ({ setup, shown }) => {
    setup();
    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    const text = `${verdict.reasons[0]?.message} ${verdict.reasons[0]?.nextAction}`;
    for (const part of shown) {
      expect(text).toContain(part);
    }
  });

  it.each([
    {
      name: "the unit runs another installation",
      setup: () =>
        systemd.readCommand.mockRejectedValue(mismatch({ programArguments: otherInstall })),
    },
    {
      name: "the unit runs as this account",
      setup: () => systemd.readCommand.mockResolvedValue({ programArguments: [] }),
    },
    {
      name: "a skipped custom unit runs another installation",
      setup: () =>
        systemd.findScope.mockImplementation(async (_env, options) => {
          options?.onAccountMismatch?.(mismatch({ programArguments: otherInstall }).mismatch);
          return null;
        }),
    },
    {
      name: "the unit could not be inspected",
      setup: () => systemd.readCommand.mockRejectedValue(new Error("bus unavailable")),
    },
    {
      name: "a user unit is selected",
      setup: () => systemd.findScope.mockResolvedValue({ ...unit, scope: "user" }),
    },
    { name: "no unit is installed", setup: () => systemd.findScope.mockResolvedValue(null) },
    {
      name: "the host is not Linux",
      setup: () => Object.defineProperty(process, "platform", { ...platform, value: "darwin" }),
    },
  ])("leaves the decision to the other checks when $name", async ({ setup }) => {
    setup();
    const verdict = await admit();

    // The broken fixture config is now inspected and judged on its own terms.
    const checks = verdict.facts.checks.map((check) => check.name);
    expect(checks).toContain("config");
    expect(checks).not.toContain("managed-service-account");
  });
});

/** A runuser stand-in: records what root handed the account and answers as the account would. */
function installAccountProcess(answer: { stdout: string; code: number; hangs?: boolean }) {
  const dir = dirs.make("service-account-process-");
  const shim = path.join(dir, "runuser");
  fs.writeFileSync(path.join(dir, "stdout"), answer.stdout);
  fs.writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'dir=$(dirname "$0")',
      'printf "%s\\n" "$@" > "$dir/argv"',
      'env > "$dir/launch-env"',
      'ls -ln "$7" > "$dir/env-mode"',
      'cp "$7" "$dir/env.json"',
      "for last; do :; done",
      'ls -ln "$last" > "$dir/context-mode"',
      'cp "$last" "$dir/context"',
      ...(answer.hangs ? ["sleep 60"] : []),
      'cat "$dir/stdout"',
      `exit ${answer.code}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  systemd.runuser.mockResolvedValue(shim);
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
  return { read, exists: (name: string) => fs.existsSync(path.join(dir, name)) };
}

function serviceVerdict(overrides: Partial<UpdateAdmissionVerdict> = {}): UpdateAdmissionVerdict {
  return {
    protocol: 1,
    verdict: "admit",
    reasons: [],
    warnings: [
      {
        code: "retired-state-format",
        message: "Doctor will migrate or archive retired state with original bytes preserved.",
      },
    ],
    facts: {
      candidateVersion,
      installedVersion: "2026.11.10",
      checks: [
        { name: "config", status: "ok" },
        { name: "database-schema", status: "ok" },
      ],
    },
    ...overrides,
  };
}

/** Rewrites the fixture context with the installed updater's admission budget. */
function setAdmissionBudget(timeoutMs: number) {
  const context = JSON.parse(fs.readFileSync(contextPath, "utf8")) as UpdateAdmissionContext;
  fs.writeFileSync(
    contextPath,
    JSON.stringify({ ...context, request: { ...context.request, timeoutMs } }),
    { mode: 0o600 },
  );
}

describe("candidate admission run as the unit's account", () => {
  it("refuses before the installed updater's deadline when the account does not answer", async () => {
    installAccountProcess({ stdout: JSON.stringify(serviceVerdict()), code: 0, hangs: true });
    // 12 s budget: the installed updater gives up at about 10.8 s and then checks root's state.
    setAdmissionBudget(12_000);
    const started = Date.now();

    const verdict = await admit();

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(process.exitCode).toBe(3);
    expect(verdict.reasons[0]?.message).toContain("(admission timeout)");
  });

  it("refuses without starting the account's checks when no time is left", async () => {
    const accountProcess = installAccountProcess({
      stdout: JSON.stringify(serviceVerdict()),
      code: 0,
    });
    setAdmissionBudget(12_000);
    vi.mocked(process.uptime).mockReturnValue(6);

    const verdict = await admit();

    expect(verdict.reasons[0]?.message).toContain("no time was left for the account's checks");
    expect(accountProcess.exists("argv")).toBe(false);
  });

  it("admits with the verdict the service account's own admission gave for its state", async () => {
    // Installed updaters stage the candidate in a private directory of their own.
    const stage = dirs.make("service-account-stage-");
    fs.chmodSync(stage, 0o755);
    const privateStage = path.join(stage, ".openclaw.update-stage-test");
    systemd.candidateRoot = path.join(privateStage, "lib", "node_modules", "openclaw");
    fs.mkdirSync(systemd.candidateRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(privateStage, 0o700);
    fs.copyFileSync(
      new URL("../../../package.json", import.meta.url),
      path.join(systemd.candidateRoot, "package.json"),
    );
    const accountProcess = installAccountProcess({
      stdout: JSON.stringify(serviceVerdict()),
      code: 0,
    });
    const before = snapshotUpdateFixtureFiles(home);

    const verdict = await admit();

    expect(process.exitCode).toBe(0);
    expect(verdict.verdict).toBe("admit");
    expect(verdict.facts.checks).toEqual([
      {
        name: "managed-service-account",
        status: "ok",
        detail: "Checked as openclaw with openclaw-gateway.service's state.",
      },
      { name: "config", status: "ok" },
      { name: "database-schema", status: "ok" },
    ]);
    expect(verdict.warnings.map((warning) => warning.code)).toEqual(["retired-state-format"]);
    // Root ran the candidate's own admission as the account, by argument vector.
    expect(accountProcess.read("argv").trim().split("\n").slice(0, 5)).toEqual([
      "-u",
      "openclaw",
      "--",
      process.execPath,
      "-e",
    ]);
    expect(accountProcess.read("argv").trim().split("\n").slice(-5)).toEqual([
      path.join(root, "dist", "index.js"),
      "update",
      "admit",
      "--context",
      expect.stringMatching(/context\.json$/u),
    ]);
    // runuser itself runs with a trusted environment; the unit's environment, including
    // loader variables it may set, applies only after the switch.
    const launchEnv = accountProcess.read("launch-env");
    expect(launchEnv).not.toContain("unit-only-value");
    expect(launchEnv).not.toContain(stateDir);
    const env = JSON.parse(accountProcess.read("env.json")) as Record<string, string>;
    expect(env).toMatchObject({
      HOME: serviceHome,
      OPENCLAW_STATE_DIR: "/var/lib/openclaw/.openclaw",
      OPENAI_API_KEY: "unit-only-value",
      USER: "openclaw",
      OPENCLAW_DEV_SOURCE_ROOT: expect.any(String),
    });
    expect(Object.values(env)).not.toContain(stateDir);
    // Only the account can read what it is handed, and nobody else can replace it.
    expect(accountProcess.read("env-mode")).toMatch(/^-r--------[@+.]? /u);
    expect(JSON.parse(accountProcess.read("context"))).toMatchObject({ installation: { root } });
    expect(accountProcess.read("context-mode")).toMatch(/^-r--------[@+.]? /u);
    const handoff = accountProcess.read("argv").trim().split("\n").at(-1)!;
    expect(fs.existsSync(path.dirname(handoff))).toBe(false);
    // The stage keeps its mode: here the account owns it, so nothing needed widening.
    expect(fs.statSync(privateStage).mode & 0o777).toBe(0o700);
    // Nothing of this process's own (broken) state was read or changed.
    expect(snapshotUpdateFixtureFiles(home)).toEqual(before);
  });

  it("passes on the account's refusal for its own state", async () => {
    installAccountProcess({
      stdout: JSON.stringify(
        serviceVerdict({
          verdict: "refuse",
          warnings: [],
          reasons: [{ code: "invalid-config", message: "skills: Unrecognized key: workshop" }],
          facts: {
            candidateVersion,
            installedVersion: "2026.11.10",
            checks: [{ name: "config", status: "refuse", detail: "skills: Unrecognized key" }],
          },
        }),
      ),
      code: 3,
    });

    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.reasons).toEqual([
      { code: "invalid-config", message: "skills: Unrecognized key: workshop" },
    ]);
    expect(verdict.facts.checks[0]).toMatchObject({ name: "managed-service-account" });
  });

  it.each([
    {
      name: "output that is not a verdict",
      stdout: "not json",
      code: 0,
      problem: "malformed verdict",
    },
    {
      name: "an admit verdict with a refusal exit status",
      stdout: JSON.stringify(serviceVerdict()),
      code: 3,
      problem: "invalid verdict",
    },
    {
      name: "a verdict for another candidate",
      stdout: JSON.stringify(
        serviceVerdict({
          facts: { candidateVersion: "2099.1.1", installedVersion: null, checks: [] },
        }),
      ),
      code: 0,
      problem: "invalid verdict",
    },
    {
      name: "a verdict that claims the account check itself",
      stdout: JSON.stringify(
        serviceVerdict({
          facts: {
            candidateVersion,
            installedVersion: null,
            checks: [{ name: "managed-service-account", status: "ok" }],
          },
        }),
      ),
      code: 0,
      problem: "invalid verdict",
    },
    {
      name: "output beyond its bound",
      stdout: JSON.stringify(serviceVerdict()) + " ".repeat(1024 * 1024),
      code: 0,
      problem: "admission output-limit",
    },
    { name: "a failed run", stdout: "", code: 2, problem: "exit 2" },
  ])("refuses before any change when the account returns $name", async (answer) => {
    installAccountProcess({ stdout: answer.stdout, code: answer.code });
    const before = snapshotUpdateFixtureFiles(home);

    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.reasons).toEqual([
      {
        code: "service-account-mismatch",
        message: `Gateway service openclaw-gateway.service runs as openclaw; its state could not be checked as openclaw (${answer.problem}).`,
        nextAction:
          "Nothing was changed. See https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account to update this system service by hand.",
      },
    ]);
    expect(snapshotUpdateFixtureFiles(home)).toEqual(before);
  });

  it.each([
    {
      name: "this update is not root",
      setup: () => setEuid(1000),
      blocker: "only root can run the service account's steps",
    },
    {
      name: "User= is numeric",
      setup: () => systemd.readCommand.mockRejectedValue(mismatch({ serviceUser: "1001" })),
      blocker: "the unit's User= (1001) is not a named service account",
    },
    {
      name: "the account does not resolve",
      setup: () => systemd.readAccount.mockResolvedValue(undefined),
      blocker: "the account openclaw could not be resolved",
    },
    {
      name: "the account cannot write its HOME",
      setup: () => fs.chmodSync(serviceHome, 0o500),
      blocker: "the unit's HOME (",
    },
    {
      name: "the unit's environment file cannot be read",
      setup: () => systemd.readAsRoot.mockRejectedValue(new Error("EnvironmentFile unreadable")),
      blocker: "the unit's effective environment could not be read",
    },
    {
      name: "this update selects the service's config itself",
      setup: () => vi.stubEnv("OPENCLAW_CONFIG_PATH", "/var/lib/openclaw/.openclaw/openclaw.json"),
      blocker:
        "this update selects the service's state or config itself, so the installed updater would write it as root; run the update again without OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH or other state selectors",
    },
    {
      name: "this update selects a directory inside the service's state",
      setup: () => vi.stubEnv("OPENCLAW_STATE_DIR", "/var/lib/openclaw/.openclaw/nested"),
      blocker:
        "this update selects the service's state or config itself, so the installed updater would write it as root; run the update again without OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH or other state selectors",
    },
    {
      name: "sandboxing hides the unit's state",
      setup: () =>
        systemd.readAsRoot.mockResolvedValue(serviceCommand({ stateIdentityUnverified: true })),
      blocker: "the unit's sandboxing or environment hides where its state is",
    },
  ])("falls back to the documented refusal when $name", async ({ setup, blocker }) => {
    const accountProcess = installAccountProcess({
      stdout: JSON.stringify(serviceVerdict()),
      code: 0,
    });
    setup();

    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.reasons[0]?.code).toBe("service-account-mismatch");
    expect(verdict.reasons[0]?.nextAction).toContain(
      `Automatic update as the service account is not possible: ${blocker}`,
    );
    expect(accountProcess.exists("argv")).toBe(false);
  });
});
