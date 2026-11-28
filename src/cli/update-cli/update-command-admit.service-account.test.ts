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
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("candidate admission for a system unit run by another account", () => {
  it.each([
    ["root", 0],
    ["admin", 1000],
  ] as const)("keeps shipped candidate state checks refused for %s", async (username, uid) => {
    vi.spyOn(os, "userInfo").mockReturnValue(account(username, uid));
    const before = snapshotUpdateFixtureFiles(home);
    const verdict = await admit();

    expect(process.exitCode).toBe(3);
    expect(verdict.verdict).toBe("refuse");
    expect(verdict.reasons[0]?.code).toBe("service-account-mismatch");
    expect(verdict.reasons[0]?.message).toContain(`this update runs as ${username}`);
    expect(snapshotUpdateFixtureFiles(home)).toEqual(before);
  });

  it("identifies a custom unit skipped by discovery for its account", async () => {
    systemd.findScope.mockImplementation(async (_env, options) => {
      options?.onAccountMismatch?.(mismatch({ unitName: "company-gateway.service" }).mismatch);
      return null;
    });
    const verdict = await admit();
    expect(verdict.reasons[0]?.message).toContain("company-gateway.service");
    expect(verdict.verdict).toBe("refuse");
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
