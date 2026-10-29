import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildLaunchAgentPlist } from "../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../daemon/launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import { buildTaskScript } from "../daemon/schtasks-layout.js";
import * as serviceOwner from "../daemon/service.js";
import * as systemdRuntime from "../daemon/systemd-runtime.js";
import * as systemdFiles from "../daemon/systemd-service-files.js";
import { withGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import * as exec from "../process/exec.js";
import { assertGatewayServiceSchemaMigrationAllowed } from "../state/openclaw-state-service-installation.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { VERSION } from "../version.js";
import { inspectCliGatewayServiceInstallation } from "./run-main-service-installation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const nativePlutil = process.platform === "darwin";
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  if (!nativePlutil) {
    // Only macOS supplies plutil; retain the real service file and identity owners.
    vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
      if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
        throw new Error(`Unexpected native command: ${file}`);
      }
      return decodeLaunchAgentPlistFixture(options.input, args[1]);
    });
  }
});

it.each(["default", "home", "profile", "state", "argv", "windows", "windows-lowercase"] as const)(
  "uses installed service %s state instead of the inspecting CLI's selectors",
  async (selector) => {
    const windows = selector === "windows" || selector === "windows-lowercase";
    await withMockedPlatform(windows ? "win32" : "darwin", async () => {
      const home = dirs.make("service-installation-");
      const callerState = path.join(home, selector === "argv" ? ".openclaw-service" : "lab-state");
      const env = {
        HOME: home,
        OPENCLAW_HOME: path.join(home, "lab-home"),
        OPENCLAW_STATE_DIR: callerState,
        OPENCLAW_PROFILE: "lab",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.scope-test",
        OPENCLAW_TASK_SCRIPT: path.join(home, "gateway.cmd"),
      };
      const root = path.join(home, "older-package");
      const entry = path.join(root, "openclaw.mjs");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "package.json"),
        '{"name":"openclaw","version":"2026.7.1"}',
      );
      await fs.writeFile(entry, "");
      const serviceHome = path.join(home, "service-home");
      const environment = {
        HOME: home,
        ...(selector === "home" ? { OPENCLAW_HOME: serviceHome } : {}),
        ...(selector === "profile" ? { OPENCLAW_PROFILE: "service" } : {}),
        ...(selector === "state" || selector === "windows"
          ? { OPENCLAW_STATE_DIR: callerState }
          : {}),
        ...(selector === "windows-lowercase" ? { openclaw_state_dir: callerState } : {}),
      };
      const service = {
        programArguments: [
          process.execPath,
          entry,
          ...(selector === "argv" ? ["--profile=service"] : []),
          "gateway",
        ],
        environment,
      };
      if (windows) {
        await fs.writeFile(env.OPENCLAW_TASK_SCRIPT, buildTaskScript(service));
      } else {
        const plist = resolveLaunchAgentPlistPath(env);
        await fs.mkdir(path.dirname(plist), { recursive: true });
        await fs.writeFile(
          plist,
          buildLaunchAgentPlist({
            ...service,
            label: env.OPENCLAW_LAUNCHD_LABEL,
            stdoutPath: path.join(home, "stdout.log"),
            stderrPath: path.join(home, "stderr.log"),
          }),
        );
      }
      const stateDir =
        selector === "state" || windows
          ? callerState
          : selector === "home"
            ? path.join(serviceHome, ".openclaw")
            : path.join(
                home,
                selector === "profile" || selector === "argv" ? ".openclaw-service" : ".openclaw",
              );
      const installation = await inspectCliGatewayServiceInstallation(env);
      expect(installation).toMatchObject({
        root,
        version: "2026.7.1",
        databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
      });
      if (!installation) {
        throw new Error("Expected installed service identity");
      }
      withGatewayServiceInstallation({ installation }, () => {
        expect(() =>
          assertGatewayServiceSchemaMigrationAllowed(installation.databasePath, 0, 2),
        ).not.toThrow();
        expect(() =>
          assertGatewayServiceSchemaMigrationAllowed(installation.databasePath, 2, 2),
        ).not.toThrow();
        const migrate = () =>
          assertGatewayServiceSchemaMigrationAllowed(
            path.join(callerState, "state", "openclaw.sqlite"),
            1,
            2,
          );
        if (selector === "state" || selector === "argv" || windows) {
          expect(migrate).toThrow("Refusing a forward database schema migration");
        } else {
          expect(migrate).not.toThrow();
        }
      });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      expect(await inspectCliGatewayServiceInstallation(env)).toBeUndefined();
    });
  },
);

it.each(["matched", "child-pid", "other-cgroup", "stopped"] as const)(
  "uses live service selectors only for a positively identified %s Gateway",
  async (identity) => {
    await withMockedPlatform("linux", async () => {
      const home = dirs.make("service-identity-");
      const root = path.join(home, "old");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "package.json"),
        '{"name":"openclaw","version":"2026.7.1"}',
      );
      const entry = path.join(root, "openclaw.mjs");
      await fs.writeFile(entry, "");
      const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "live") };
      const command = {
        programArguments: [process.execPath, entry, "gateway"],
        environment: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "saved") },
      };
      const owner = serviceOwner.resolveGatewayService();
      const fallback = vi.fn(async () => command);
      vi.spyOn(serviceOwner, "resolveGatewayService").mockReturnValue({
        ...owner,
        readCommand: fallback,
      });
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation((...args) =>
        args[0] === "/proc/self/cgroup"
          ? Promise.resolve("0::/system.slice/openclaw.service\n")
          : readFile(...args),
      );
      const location = vi
        .spyOn(systemdFiles, "readSystemdServiceCommandLocation")
        .mockResolvedValue({ kind: "command", command });
      vi.spyOn(systemdRuntime, "readSystemdServiceRuntime").mockResolvedValue({
        status: identity === "stopped" ? "stopped" : "running",
        state: "active",
        subState: "running",
        pid: identity === "child-pid" ? process.pid + 1 : process.pid,
        systemd: {
          scope: "system",
          unit: "openclaw.service",
          controlGroup: identity === "other-cgroup" ? "/other" : "/system.slice/openclaw.service",
        },
      });
      const argv = process.argv;
      process.argv = [process.execPath, entry, "gateway", "run"];
      try {
        expect(await inspectCliGatewayServiceInstallation(env)).toMatchObject({
          databasePath: path.join(
            home,
            identity === "matched" ? "live" : "saved",
            "state",
            "openclaw.sqlite",
          ),
        });
        expect(location).toHaveBeenCalledWith(env, {
          scope: "system",
          unitName: "openclaw.service",
          unitPath: "/etc/systemd/system/openclaw.service",
        });
        expect(fallback).toHaveBeenCalledTimes(identity === "matched" ? 0 : 1);
      } finally {
        process.argv = argv;
      }
    });
  },
);

it("refuses migration through a discovered installed database hardlink alias", async () => {
  const home = dirs.make("review-hardlink-");
  const callerState = path.join(home, "caller");
  const serviceState = path.join(home, "service");
  syncFs.mkdirSync(path.join(callerState, "state"), { recursive: true });
  syncFs.mkdirSync(path.join(serviceState, "state"), { recursive: true });
  const callerDatabase = path.join(callerState, "state", "openclaw.sqlite");
  const serviceDatabase = path.join(serviceState, "state", "openclaw.sqlite");
  syncFs.writeFileSync(callerDatabase, "synthetic identity only");
  syncFs.linkSync(callerDatabase, serviceDatabase);
  const root = path.join(home, "older-package");
  syncFs.mkdirSync(root);
  syncFs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.7.1" }),
  );
  const entry = path.join(root, "openclaw.mjs");
  syncFs.writeFileSync(entry, "");
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: callerState,
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.review",
  };
  const plist = resolveLaunchAgentPlistPath(env);
  syncFs.mkdirSync(path.dirname(plist), { recursive: true });
  syncFs.writeFileSync(
    plist,
    buildLaunchAgentPlist({
      programArguments: [process.execPath, entry, "gateway"],
      environment: { HOME: home, OPENCLAW_STATE_DIR: serviceState },
      label: env.OPENCLAW_LAUNCHD_LABEL,
      stdoutPath: path.join(home, "stdout"),
      stderrPath: path.join(home, "stderr"),
    }),
  );
  const spy = vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
    if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
      throw new Error("Unexpected native command");
    }
    return decodeLaunchAgentPlistFixture(options.input, args[1]);
  });
  try {
    const installation = await withMockedPlatform("darwin", () =>
      inspectCliGatewayServiceInstallation(env),
    );
    expect(installation).toBeDefined();
    expect(syncFs.statSync(callerDatabase).ino).toBe(syncFs.statSync(serviceDatabase).ino);
    withGatewayServiceInstallation({ installation }, () => {
      expect(() => assertGatewayServiceSchemaMigrationAllowed(callerDatabase, 1, 2)).toThrow(
        "Refusing a forward database schema migration",
      );
    });
  } finally {
    spy.mockRestore();
  }
});
