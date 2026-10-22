import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { execFileUtf8 } from "./exec-file.js";
import { isLaunchctlNotLoaded } from "./launchd-exec.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  assertSystemdAvailable as assertAvailable,
  isSystemctlAvailable as isAvailable,
  isSystemdUserServiceAvailable as isUserAvailable,
  execSystemctl,
  execSystemctlUser,
  systemdInspectionError,
} from "./systemd-exec.js";
import {
  uninstallLegacySystemdUnits,
  uninstallUserSystemdGatewayUnit as uninstallUser,
} from "./systemd-lifecycle.js";
import {
  classifySystemdUnavailableDetail as classify,
  isSystemctlMissingDetail,
} from "./systemd-unavailable.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

function captureOutput() {
  const chunks: Buffer[] = [];
  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stdout, output: () => Buffer.concat(chunks).toString() };
}
const generic = "generic_unavailable";

it("classifies missing systemctl details", () => {
  expect(isSystemctlMissingDetail("spawn systemctl ENOENT")).toBe(true);
  expect(classify("systemctl not available")).toBe("missing_systemctl");
});

it("classifies generic systemd-unavailable details", () => {
  expect(classify("System has not been booted with systemd as init system")).toBe(generic);
  expect(classify("not supported on this host")).toBe(generic);
});
describe.skipIf(process.platform === "win32")("systemd process availability", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let dir: string;
  let env: GatewayServiceEnv;
  beforeEach(async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    dir = dirs.make("openclaw-systemctl-");
    const address = `unix:path=${path.join(dir, "bus")}`;
    env = { HOME: dir, PATH: dir, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: address };
    await commandFixture(
      "busctl",
      `#!/bin/sh
[ "$*" = "--user --auto-start=no get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Version" ] || exit 91
printf 's "252.39"\\n'
`,
    );
  });
  afterEach(() => vi.restoreAllMocks());
  async function commandFixture(command: "systemctl" | "busctl", script: string) {
    await fs.writeFile(path.join(dir, `${command}.sh`), script, { mode: 0o600 });
    // Execute an immutable launcher so a newly written script inode cannot be text-busy.
    await fs.symlink(
      fileURLToPath(new URL("../../test/fixtures/service-manager-command.sh", import.meta.url)),
      path.join(dir, command),
    );
  }
  async function writeUnit(unitName: string, definition: string) {
    const unitPath = path.join(dir, ".config/systemd/user", unitName);
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(unitPath, definition);
    return unitPath;
  }
  const calls = async () =>
    (await fs.readFile(path.join(dir, "systemctl.calls"), "utf8")).trim().split("\n");
  const absent = (file: string) => expect(fs.access(file)).rejects.toHaveProperty("code", "ENOENT");
  async function cleanupCommand(disable: string, enabled = "") {
    await commandFixture(
      "systemctl",
      `#!/bin/sh
printf "%s\\n" "$*" >> "$HOME/systemctl.calls"
case " $* " in
*" status "*|*" --version "*) kill -TERM $$ ;;
${enabled}
*" disable "*) ${disable} ;;
esac`,
    );
  }

  it.each([
    { probe: "show", scope: "user" },
    { probe: "cat", scope: "user" },
    { probe: "is-active", scope: "user" },
    { probe: "show", scope: "system" },
  ])("sanitizes failed $scope $probe diagnostics", async ({ probe, scope }) => {
    const script =
      "#!/bin/sh\nprintf '\\033[31mFailed to connect to user bus\\033[0m\\nPRIVATE_SECOND_LINE\\n' >&2\nexit 7\n";
    await commandFixture("systemctl", script);
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
  });

  it("rejects unavailable systemctl with EACCES", async () => {
    await fs.writeFile(path.join(dir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    expect([await isAvailable(env), await isUserAvailable(env)]).toEqual([false, false]);
    await expect(assertAvailable(env)).rejects.toThrow("service-manager check could not start");

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
    await commandFixture("systemctl", `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`);
    const expected = { stdout: `${output}\n`, stderr: "", code, termination: "exit" };
    await expect(execFileUtf8("systemctl", ["--user", "status"], { env })).resolves.toEqual(
      expected,
    );
    await expect(isAvailable(env)).resolves.toBe(true);
    await expect(isUserAvailable(env)).resolves.toBe(available);
    if (available) {
      await expect(assertAvailable(env)).resolves.toBeUndefined();
    } else {
      await expect(assertAvailable(env)).rejects.toMatchObject({
        reason: "systemd-user-bus-unavailable",
      });
    }
  });

  it.each(["timeout", "signal"])("rejects partial status after %s", async (termination) => {
    const script = `#!/bin/sh\nprintf 'Could not find service\\n'\n${termination === "timeout" ? "exec /bin/sleep 10" : "kill -TERM $$"}\n`;
    await commandFixture("systemctl", script);
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
      // Advance after stdout, including the extra timer turn used by deadline decisions.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = run();
      try {
        await ready.promise;
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersToNextTimerAsync();
        return await result;
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
        commandSpy.mockRestore();
        await result.catch(() => undefined);
      }
    };
    await runAfterOutput(() =>
      expect(assertAvailable(env, timeout)).rejects.toThrow(
        termination === "timeout"
          ? "systemd manager inspection deadline expired"
          : "systemctl --user status: signal; Command was terminated by SIGTERM",
      ),
    );
    const result = await runAfterOutput(() =>
      execFileUtf8("systemctl", ["--user", "status"], { env, timeout, killSignal: "SIGKILL" }),
    );
    expect(result).toMatchObject({
      stdout: "Could not find service\n",
      termination,
      stderr: expect.stringContaining(
        termination === "timeout" ? "Command timed out" : "Command was terminated by SIGTERM",
      ),
    });
    expect(result.code).not.toBe(0);
    expect(isLaunchctlNotLoaded(result)).toBe(false);
    if (termination === "signal") {
      expect([await isAvailable(env), await isUserAvailable(env)]).toEqual([true, false]);
    }
  });

  describe.each([
    { unitName: "clawdbot-gateway.service", uninstall: uninstallLegacySystemdUnits },
    { unitName: "openclaw-gateway.service", uninstall: uninstallUser },
  ])("$unitName cleanup", ({ unitName, uninstall }) => {
    it.each(["failure", "success", "missing"])("cleanup %s", async (mode) => {
      const disableFails = mode === "failure";
      const definition = "[Unit]\nDescription=Gateway cleanup fixture\n";
      const unitPath = await writeUnit(unitName, definition);
      if (mode !== "missing") {
        await cleanupCommand(
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
      if (mode === "missing") {
        await absent(path.join(dir, "systemctl.calls"));
        expect(output()).toContain("systemctl unavailable");
      } else {
        const recorded = await calls();
        expect(recorded).toContain(`--user disable --now ${unitName}`);
        expect(recorded.includes("--user daemon-reload")).toBe(!disableFails);
        expect(output()).not.toContain("systemctl unavailable");
      }
    });
  });

  it.each([false, true])("requires matching profile discovery: %s", async (matches) => {
    env = { ...env, OPENCLAW_PROFILE: "lisa" };
    const unitName = "openclaw-lisa.service";
    const definition = "[Unit]\nDescription=OpenClaw Gateway (profile: lisa)\n";
    const unitPath = await writeUnit(unitName, definition);
    if (matches) {
      await cleanupCommand("exit 0");
    }
    const { stdout, output } = captureOutput();
    const name = matches ? unitName : "openclaw-gateway-lisa.service";
    const unitFile = path.join(path.dirname(unitPath), name);
    const target = { scope: "user" as const, unitName: name, unitPath: unitFile };
    const removal = uninstallUser({ env, stdout, target });
    if (!matches) {
      await expect(removal).rejects.toThrow(
        /openclaw-gateway-lisa\.service changed to openclaw-lisa\.service/,
      );
      await fs.access(unitPath);
      return;
    }
    expect(await removal).toMatchObject({ unitName, unitPath, removed: true, disabled: true });
    await absent(unitPath);
    expect(await calls()).toContain("--user disable --now openclaw-lisa.service");
    expect(output()).toContain("Removed");
  });
});
