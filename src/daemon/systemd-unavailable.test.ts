import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { execFileUtf8 } from "./exec-file.js";
import { isLaunchctlNotLoaded } from "./launchd-exec.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  assertSystemdAvailable,
  isSystemctlAvailable,
  isSystemdUserServiceAvailable,
  execSystemctl,
  execSystemctlUser,
  systemdInspectionError,
} from "./systemd-exec.js";
import {
  uninstallLegacySystemdUnits,
  uninstallUserSystemdGatewayUnit,
} from "./systemd-lifecycle.js";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
} from "./systemd-unavailable.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

function captureOutput() {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { stdout, output: () => output };
}

describe("classifySystemdUnavailableDetail", () => {
  it("classifies missing systemctl details", () => {
    expect(isSystemctlMissingDetail("spawn systemctl ENOENT")).toBe(true);
    expect(classifySystemdUnavailableDetail("systemctl not available")).toBe("missing_systemctl");
  });

  it("classifies generic systemd-unavailable details", () => {
    expect(
      classifySystemdUnavailableDetail("System has not been booted with systemd as init system"),
    ).toBe("generic_unavailable");
    expect(classifySystemdUnavailableDetail("not supported on this host")).toBe(
      "generic_unavailable",
    );
  });
});

describe.skipIf(process.platform === "win32")("systemd process availability", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let dir: string;
  let env: GatewayServiceEnv;
  beforeEach(async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    dir = dirs.make("openclaw-systemctl-");
    env = systemctlEnv(dir);
    await managerProbe(dir);
  });
  afterEach(() => vi.restoreAllMocks());
  async function commandFixture(root: string, command: "systemctl" | "busctl", script: string) {
    await fs.writeFile(path.join(root, `${command}.sh`), script, { mode: 0o600 });
    // Execute an immutable launcher so a newly written script inode cannot be text-busy.
    await fs.symlink(
      fileURLToPath(new URL("../../test/fixtures/service-manager-command.sh", import.meta.url)),
      path.join(root, command),
    );
  }
  async function managerProbe(root: string) {
    await commandFixture(
      root,
      "busctl",
      `#!/bin/sh
[ "$*" = "--user --auto-start=no get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Version" ] || exit 91
printf 's "252.39"\\n'
`,
    );
  }
  function systemctlEnv(root: string) {
    return {
      HOME: root,
      PATH: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, "bus")}`,
    };
  }
  async function writeUnit(root: string, unitName: string, definition: string) {
    const unitPath = path.join(root, ".config/systemd/user", unitName);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(unitPath, definition);
    return unitPath;
  }
  const calls = async (root: string) =>
    (await fs.readFile(path.join(root, "systemctl.calls"), "utf8")).trim().split("\n");
  const absent = (file: string) =>
    expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
  async function cleanupCommand(root: string, disable: string, enabled = "") {
    await commandFixture(
      root,
      "systemctl",
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$HOME/systemctl.calls"',
        'case " $* " in',
        '*" status "*|*" --version "*) kill -TERM $$ ;;',
        enabled,
        `*" disable "*) ${disable} ;;`,
        "esac",
      ].join("\n"),
    );
  }

  it.each([
    { probe: "show", scope: "user" },
    { probe: "cat", scope: "user" },
    { probe: "is-active", scope: "user" },
    { probe: "show", scope: "system" },
  ])(
    "retains the failed native probe $scope $probe and sanitized stderr",
    async ({ probe, scope }) => {
      await commandFixture(
        dir,
        "systemctl",
        "#!/bin/sh\nprintf '\\033[31mFailed to connect to user bus\\033[0m\\nPRIVATE_SECOND_LINE\\n' >&2\nexit 7\n",
      );
      const result =
        scope === "user"
          ? await execSystemctlUser(env, [probe, "openclaw-gateway.service"], 5000)
          : await execSystemctl([probe, "openclaw-gateway.service"], env, 5000);
      const error = systemdInspectionError(result, "inspection failed");
      expect(error.message).toContain(
        `systemctl --${scope} ${probe}: exit 7; Failed to connect to user bus`,
      );
      expect(error.message).not.toContain("PRIVATE_SECOND_LINE");
      expect(error.message).not.toContain("\u001b");
    },
  );

  it("rejects unavailable systemctl with EACCES", async () => {
    await fs.writeFile(path.join(dir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    await expect(isSystemctlAvailable(env)).resolves.toBe(false);
    await expect(isSystemdUserServiceAvailable(env)).resolves.toBe(false);
    await expect(assertSystemdAvailable(env)).rejects.toThrow(
      "service-manager check could not start",
    );

    const result = await execFileUtf8("systemctl", ["private-argument"], { env });
    expect(result).toMatchObject({ stdout: "", code: 1, errorCode: "EACCES" });
    expect(result.stderr).not.toContain("private-argument");
    expect(isLaunchctlNotLoaded(result)).toBe(false);
  });

  it.each([
    { output: "running", code: 0, available: true },
    { output: "degraded", code: 1, available: true },
    { output: "Failed to connect to bus: No medium found", code: 1, available: false },
  ])("preserves manager status $output", async ({ output, code, available }) => {
    await commandFixture(dir, "systemctl", `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`);
    await expect(execFileUtf8("systemctl", ["--user", "status"], { env })).resolves.toEqual({
      stdout: `${output}\n`,
      stderr: "",
      code,
      termination: "exit",
    });
    await expect(isSystemctlAvailable(env)).resolves.toBe(true);
    await expect(isSystemdUserServiceAvailable(env)).resolves.toBe(available);
    if (available) {
      await expect(assertSystemdAvailable(env)).resolves.toBeUndefined();
    } else {
      await expect(assertSystemdAvailable(env)).rejects.toMatchObject({
        reason: "systemd-user-bus-unavailable",
      });
    }
  });

  it.each(["timeout", "signal"])("rejects partial status after %s", async (termination) => {
    await commandFixture(
      dir,
      "systemctl",
      `#!/bin/sh\nprintf 'Could not find service\\n'\n${termination === "timeout" ? "exec /bin/sleep 10" : "kill -TERM $$"}\n`,
    );
    const timeout = termination === "timeout" ? 500 : undefined;
    await resolveSystemdUserTransport(env);
    const runAfterOutput = async <T>(run: () => Promise<T>): Promise<T> => {
      if (termination !== "timeout") {
        return await run();
      }
      const ready = createDeferredCore();
      const runCommand = processExec.runCommandWithTimeout;
      const commandSpy = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation((argv, options) =>
          runCommand(argv, {
            ...(typeof options === "number" ? { timeoutMs: options } : options),
            onOutputChunk: (_chunk, stream) => {
              if (stream === "stdout" && argv[0] === "systemctl") {
                ready.resolve();
              }
            },
          }),
        );
      // Timeout normalization must follow observed child output, not race
      // a cold shell startup on a loaded test worker.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = run();
      try {
        await ready.promise;
        await vi.advanceTimersByTimeAsync(500);
        // Command deadlines take their decision one timer turn after expiry.
        await vi.advanceTimersToNextTimerAsync();
        return await result;
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
        commandSpy.mockRestore();
        await result.catch(() => undefined);
      }
    };
    await runAfterOutput(async () => {
      await expect(assertSystemdAvailable(env, timeout)).rejects.toThrow(
        termination === "timeout"
          ? "systemd manager inspection deadline expired"
          : "systemctl --user status: signal; Command was terminated by SIGTERM",
      );
    });
    const result = await runAfterOutput(() =>
      execFileUtf8("systemctl", ["--user", "status"], {
        env,
        timeout,
        killSignal: "SIGKILL",
      }),
    );
    expect(result).toMatchObject({ stdout: "Could not find service\n", termination });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      termination === "timeout" ? "Command timed out" : "Command was terminated by SIGTERM",
    );
    expect(isLaunchctlNotLoaded(result)).toBe(false);
    if (termination === "signal") {
      await expect(isSystemctlAvailable(env)).resolves.toBe(true);
      await expect(isSystemdUserServiceAvailable(env)).resolves.toBe(false);
    }
  });

  describe.each([
    { unitName: "clawdbot-gateway.service", uninstall: uninstallLegacySystemdUnits },
    { unitName: "openclaw-gateway.service", uninstall: uninstallUserSystemdGatewayUnit },
  ])("$unitName cleanup", ({ unitName, uninstall }) => {
    it.each([
      { availability: "signal", disableFails: true },
      { availability: "signal", disableFails: false },
      { availability: "missing", disableFails: false },
    ])(
      "handles $availability status with disable failure $disableFails",
      async ({ availability, disableFails }) => {
        const definition = "[Unit]\nDescription=Gateway cleanup fixture\n";
        const unitPath = await writeUnit(dir, unitName, definition);
        if (availability !== "missing") {
          await cleanupCommand(
            dir,
            `test -f "$HOME/.config/systemd/user/${unitName}" || exit 98\n${disableFails ? "kill -TERM $$" : "exit 0"}`,
            '*" is-enabled "*) printf "enabled\\n" ;;',
          );
        }
        const { stdout, output } = captureOutput();
        if (disableFails) {
          await expect(uninstall({ env, stdout })).rejects.toThrow("systemctl disable failed:");
          await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(definition);
          expect(output()).not.toContain("Removed");
        } else {
          await uninstall({ env, stdout });
          await absent(unitPath);
          expect(output()).toContain("Removed");
        }
        if (availability === "missing") {
          await absent(path.join(dir, "systemctl.calls"));
          expect(output()).toContain("systemctl unavailable");
        } else {
          const recorded = await calls(dir);
          expect(recorded).toContain(`--user disable --now ${unitName}`);
          expect(recorded.includes("--user daemon-reload")).toBe(!disableFails);
          expect(output()).not.toContain("systemctl unavailable");
        }
      },
    );
  });

  it("refuses cleanup when the inspected user unit is replaced by a leftover legacy unit", async () => {
    env = { ...env, OPENCLAW_PROFILE: "lisa" };
    const leftoverPath = await writeUnit(
      dir,
      "openclaw-lisa.service",
      "[Unit]\nDescription=OpenClaw Gateway (profile: lisa)\n",
    );
    const canonicalPath = path.join(path.dirname(leftoverPath), "openclaw-gateway-lisa.service");
    const { stdout } = captureOutput();
    await expect(
      uninstallUserSystemdGatewayUnit({
        env,
        stdout,
        target: {
          scope: "user",
          unitName: "openclaw-gateway-lisa.service",
          unitPath: canonicalPath,
        },
      }),
    ).rejects.toThrow(/openclaw-gateway-lisa\.service changed to openclaw-lisa\.service/);
    await fs.access(leftoverPath);
  });

  it("still removes the inspected user unit when discovery still matches", async () => {
    env = { ...env, OPENCLAW_PROFILE: "lisa" };
    const unitPath = await writeUnit(
      dir,
      "openclaw-lisa.service",
      "[Unit]\nDescription=OpenClaw Gateway (profile: lisa)\n",
    );
    await cleanupCommand(dir, "exit 0");
    const { stdout, output } = captureOutput();
    const result = await uninstallUserSystemdGatewayUnit({
      env,
      stdout,
      target: { scope: "user", unitName: "openclaw-lisa.service", unitPath },
    });
    expect(result).toMatchObject({
      unitName: "openclaw-lisa.service",
      unitPath,
      removed: true,
      disabled: true,
    });
    await absent(unitPath);
    expect(await calls(dir)).toContain("--user disable --now openclaw-lisa.service");
    expect(output()).toContain("Removed");
  });
});
