import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";
import { execDockerRawUnavailable } from "./audit.test-helpers.js";

const isWindows = process.platform === "win32";

describe("security audit config include permissions", () => {
  it("flags group/world-readable config include files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-include-perms-"));
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

    const includePath = path.join(stateDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    if (isWindows) {
      const { execSync } = await import("node:child_process");
      execSync(`icacls "${includePath}" /grant Everyone:W`, { stdio: "ignore" });
    } else {
      await fs.chmod(includePath, 0o644);
    }

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, `{ "$include": "./extra.json5" }\n`, "utf-8");
    await fs.chmod(configPath, 0o600);

    const cfg: OpenClawConfig = { logging: { redactSensitive: "off" } };
    const user = "DESKTOP-TEST\\Tester";
    const execIcacls = isWindows
      ? async (_cmd: string, args: string[]) => {
          const target = args[0];
          if (target === includePath) {
            return {
              stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Users:(W)\n ${user}:(F)\n`,
              stderr: "",
            };
          }
          return {
            stdout: `${target} NT AUTHORITY\\SYSTEM:(F)\n ${user}:(F)\n`,
            stderr: "",
          };
        }
      : undefined;

    const res = await runSecurityAudit({
      config: cfg,
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir,
      configPath,
      platform: isWindows ? "win32" : undefined,
      env: isWindows
        ? { ...process.env, USERNAME: "Tester", USERDOMAIN: "DESKTOP-TEST" }
        : undefined,
      execIcacls,
      execDockerRawFn: execDockerRawUnavailable,
    });

    const expectedCheckId = isWindows
      ? "fs.config_include.perms_writable"
      : "fs.config_include.perms_world_readable";

    expect(res.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: expectedCheckId, severity: "critical" }),
      ]),
    );
  });
});
