import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildLaunchAgentPlist } from "../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../daemon/launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import { buildTaskScript } from "../daemon/schtasks-layout.js";
import { withGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import * as exec from "../process/exec.js";
import { assertGatewayServiceSchemaMigrationAllowed } from "../state/openclaw-state-service-installation.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
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
      withGatewayServiceInstallation({ installation }, () => {
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
    });
  },
);
