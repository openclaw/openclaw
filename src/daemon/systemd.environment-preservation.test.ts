import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import { execFileUtf8 } from "./exec-file.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { resolveManagedGatewayServiceCommand } from "./service-types.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";
import { stageSystemdService } from "./systemd-install.js";
import { readSystemdServiceExecStart, resolveSystemdUnitPath } from "./systemd-service-files.js";
import { buildSystemdUnit } from "./systemd-unit.js";

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
// Native responses are fixtures; no host service manager or runtime probe is contacted.
vi.mock("./systemd-user-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-user-transport.js")>()),
  resolveSystemdUserTransport: vi.fn(async () => undefined),
}));
vi.mock("./runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-paths.js")>()),
  resolveSystemNodeInfo: vi.fn(async () => null),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.mocked(execFileUtf8).mockReset();
});
afterEach(() => vi.restoreAllMocks());

function mockSystemdManagerSnapshot(
  snapshot: SystemdManagerSnapshotFixture & { fragmentPath: string },
) {
  const unitProperties = buildSystemdUnitPropertyOutput(snapshot);
  const serviceProperties = buildSystemdManagerPropertyOutput(snapshot);
  vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
    let stdout: string;
    if (command === "busctl" && (args.includes("LoadUnit") || args.includes("GetUnit"))) {
      stdout = JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] });
    } else if (command === "busctl" && args.includes("org.freedesktop.systemd1.Unit")) {
      stdout = unitProperties;
    } else if (command === "busctl" && args.includes("org.freedesktop.systemd1.Service")) {
      stdout = serviceProperties;
    } else if (command === "systemctl" && args.includes("--property=LoadState")) {
      stdout = "not-found";
    } else if (command === "systemctl" && args.includes("--property=UnitPath")) {
      stdout = path.join(path.dirname(snapshot.fragmentPath), "absent-system-units");
    } else if (command === "systemctl" && args[0] === "--user" && args[1] === "show") {
      stdout =
        "After=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nLoadState=loaded\nTimeoutStopUSec=330s\n";
    } else if (command === "systemctl" && args[0] === "--user" && args[1] === "status") {
      stdout = "";
    } else {
      throw new Error(`Unexpected native fixture request: ${command} ${args.join(" ")}`);
    }
    return { code: 0, termination: "exit", stdout, stderr: "" };
  });
}

// Unit publication and POSIX PATH semantics are platform contracts.
describe.skipIf(process.platform === "win32")("systemd operator environment preservation", () => {
  it.each([
    { source: "EnvironmentFile", servicePath: "/usr/local/bin:/usr/bin:/bin" },
    { source: "Environment", servicePath: "/usr/local/bin:/opt/operator/bin:/usr/bin:/bin" },
  ])(
    "preserves operator $source settings across audited reinstall",
    async ({ source, servicePath: systemPath }) => {
      const home = await fs.realpath(tempDirs.make("systemd-environment-preservation-"));
      const servicePath = `/opt/openclaw-runtime/bin:${systemPath}:${home}/.local/bin:${home}/.npm-global/bin:${home}/bin:${home}/.nix-profile/bin`;
      const stateDir = path.join(home, "state");
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-environment-proof",
      };
      const unitPath = resolveSystemdUnitPath(env);
      await fs.mkdir(stateDir, { mode: 0o700 });
      await fs.mkdir(`${unitPath}.d`, { recursive: true, mode: 0o700 });
      const wrapperPath = path.join(stateDir, "openclaw-wrapper");
      const dropInPath = `${unitPath}.d/operator.conf`;
      const operatorFile = path.join(stateDir, "operator.env");
      const operatorKey = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
      const operatorValue = "120000";
      const base = {
        programArguments: [wrapperPath, "gateway", "--port", "18789"],
        environment: {
          ...env,
          OPENCLAW_SYSTEMD_UNIT: `${env.OPENCLAW_SYSTEMD_UNIT}.service`,
          PATH: servicePath,
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: operatorKey,
        },
      };
      const dropIn = `[Service]\n${source}=${source === "EnvironmentFile" ? operatorFile : `${operatorKey}=${operatorValue}`}\n`;
      await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await fs.writeFile(unitPath, buildSystemdUnit(base), { mode: 0o600 });
      await fs.writeFile(dropInPath, dropIn, { mode: 0o600 });
      if (source === "EnvironmentFile") {
        await fs.writeFile(operatorFile, `${operatorKey}=${operatorValue}\n`, { mode: 0o600 });
      }
      const snapshot: SystemdManagerSnapshotFixture & { fragmentPath: string } = {
        ...base,
        fragmentPath: unitPath,
        dropInPaths: [dropInPath],
        environment: [
          ...Object.entries(base.environment).map(([key, value]) => `${key}=${value}`),
          ...(source === "Environment" ? [`${operatorKey}=${operatorValue}`] : []),
        ],
        environmentFiles: source === "EnvironmentFile" ? [[operatorFile, false]] : [],
      };
      mockSystemdManagerSnapshot(snapshot);
      const command = expectDefined(
        await readSystemdServiceExecStart(env, { requireEffective: true }),
        "effective service command",
      );
      expect(command.environment?.[operatorKey]).toBe(operatorValue);
      expect(command.managedOverrides?.environment).toEqual({ keys: [operatorKey] });
      const managed = expectDefined(resolveManagedGatewayServiceCommand(command), "managed base");
      expect(managed.environment?.[operatorKey]).toBeUndefined();
      const plan = await buildGatewayInstallPlan({
        env,
        port: 18789,
        runtime: "node",
        platform: "linux",
        runtimePath: "/opt/openclaw-runtime/bin/node",
        wrapperPath,
        existingCommand: command,
        existingEnvironment: managed.environment,
        existingEnvironmentValueSources: managed.environmentValueSources,
        authStore: { version: 1, profiles: {} },
      });
      expect(plan.environment.PATH).toBe(servicePath);
      const audit = await auditGatewayServiceConfig({
        env,
        command,
        expectedCommand: plan,
        expectedServicePath: plan.environment.PATH,
        platform: "linux",
      });
      expect(audit.definitionDriftError).toBeUndefined();
      expect(audit.definitionDrift).toBeUndefined();
      expect(audit.issues).toEqual([]);
      expect(plan.environment[operatorKey]).toBeUndefined();

      const stdout = new PassThrough();
      await stageSystemdService({ env, stdout, ...plan });
      const rewrittenUnit = await fs.readFile(unitPath, "utf8");
      expect(rewrittenUnit).not.toContain(operatorKey);
      await expect(fs.readFile(dropInPath, "utf8")).resolves.toBe(dropIn);
      if (source === "EnvironmentFile") {
        await expect(fs.readFile(operatorFile, "utf8")).resolves.toBe(
          `${operatorKey}=${operatorValue}\n`,
        );
      }
      mockSystemdManagerSnapshot({
        ...snapshot,
        programArguments: plan.programArguments,
        environment: [
          ...Object.entries(plan.environment).flatMap(([key, value]) =>
            value === undefined ? [] : [`${key}=${value}`],
          ),
          ...(source === "Environment" ? [`${operatorKey}=${operatorValue}`] : []),
        ],
      });
      const rewritten = await readSystemdServiceExecStart(env, { requireEffective: true });
      expect(rewritten?.environment?.[operatorKey]).toBe(operatorValue);
      expect(rewritten?.managedDefinition?.environment?.[operatorKey]).toBeUndefined();
      expect(rewritten?.managedDefinition?.environment?.PATH).toBe(plan.environment.PATH);
    },
  );
});
