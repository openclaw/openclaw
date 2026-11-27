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
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import {
  parseUpdateAdmissionVerdict,
  type UpdateAdmissionVerdict,
} from "../../infra/update-run-schema.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { updateAdmitCommand } from "./update-command-admit.js";
import { snapshotUpdateFixtureFiles } from "./update-command-filesystem-snapshot.test-support.js";

// Unit selection and the bus read have their own owner tests; these tests feed
// their observed results to admission and check the verdict a driver receives.
const systemd = vi.hoisted(() => ({
  findScope: vi.fn<(env: NodeJS.ProcessEnv) => Promise<SystemdServiceReadTarget | null>>(),
  readCommand: vi.fn<(env: NodeJS.ProcessEnv) => Promise<unknown>>(),
}));
vi.mock("../../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: systemd.findScope,
}));
vi.mock("../../daemon/systemd-service-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceExecStart: systemd.readCommand,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const previousExitCode = process.exitCode;
const candidateVersion = JSON.parse(
  fs.readFileSync(
    path.join(resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })!, "package.json"),
    "utf8",
  ),
).version as string;
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
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "root",
    uid: 0,
    gid: 0,
    homedir: "/root",
    shell: "/bin/sh",
  });
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
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
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
    const message = `Gateway service openclaw-gateway.service runs as openclaw, but this update runs as root and would back up and check ${stateDir} instead of the service's state. The package, the service state and the Gateway were not changed.`;
    expect(verdict.facts.checks).toEqual([
      { name: "managed-service-account", status: "refuse", detail: message },
    ]);
    expect(verdict.reasons).toEqual([
      {
        code: "service-account-mismatch",
        message,
        nextAction:
          "Update this system service by hand (https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account). " +
          "First make a verified backup of its state as openclaw: sudo -u openclaw env HOME=/var/lib/openclaw OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw openclaw backup create --verify --output /var/lib/openclaw. " +
          `Then run sudo npm install -g openclaw@${candidateVersion} --allow-scripts=openclaw and sudo systemctl restart openclaw-gateway.service.`,
      },
    ]);
    expect(JSON.stringify(verdict.reasons)).not.toMatch(/doctor|update repair|stop --force/u);
    expect(snapshotUpdateFixtureFiles(home)).toEqual(before);
  });

  it("refuses when this account selects the service's own state", async () => {
    systemd.readCommand.mockRejectedValue(
      mismatch({ selectors: { HOME: "/var/lib/openclaw", OPENCLAW_STATE_DIR: stateDir } }),
    );

    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.reasons[0]?.message).toContain(
      "this update runs as root and would write that service's state as root.",
    );
  });

  it("keeps the reinstall with the account and package manager that own the installation", async () => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "admin",
      uid: 1000,
      gid: 1000,
      homedir: "/home/admin",
      shell: "/bin/sh",
    });
    const context = JSON.parse(fs.readFileSync(contextPath, "utf8")) as UpdateAdmissionContext;
    context.installation.packageManager = "pnpm";
    fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });

    const verdict = await admit();

    expect(verdict.reasons[0]?.message).toContain("this update runs as admin");
    expect(verdict.reasons[0]?.nextAction).toContain(
      `Then run pnpm add -g --allow-build=openclaw openclaw@${candidateVersion} and sudo systemctl restart openclaw-gateway.service.`,
    );
  });

  it("asks for the unit's own selectors when they come from an environment file", async () => {
    systemd.readCommand.mockRejectedValue(mismatch({ selectorsIncomplete: true }));

    const verdict = await admit();

    expect(verdict.reasons[0]?.message).toContain("instead of the service's state");
    expect(verdict.reasons[0]?.nextAction).toContain(
      "sudo -u openclaw env <the unit's HOME, OPENCLAW_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH and OPENCLAW_PROFILE> openclaw backup create --verify --output <directory>",
    );
  });

  it.each([
    {
      name: "the unit runs another installation",
      setup: () =>
        systemd.readCommand.mockRejectedValue(
          mismatch({ programArguments: ["/usr/bin/node", "/opt/other/openclaw/dist/index.js"] }),
        ),
    },
    {
      name: "the unit runs as this account",
      setup: () => systemd.readCommand.mockResolvedValue({ programArguments: [] }),
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
  ])("leaves the decision to the other checks when $name", async ({ setup }) => {
    setup();

    const verdict = await admit();

    // The broken fixture config is now inspected and refused on its own terms.
    expect(verdict.facts.checks.map((check) => check.name)).not.toContain(
      "managed-service-account",
    );
    expect(verdict.reasons.map((reason) => reason.code)).not.toContain("service-account-mismatch");
    expect(verdict.facts.checks.map((check) => check.name)).toContain("config");
  });

  it("does not inspect systemd on other platforms", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });

    const verdict = await admit();

    expect(systemd.findScope).not.toHaveBeenCalled();
    expect(verdict.reasons.map((reason) => reason.code)).not.toContain("service-account-mismatch");
  });
});
