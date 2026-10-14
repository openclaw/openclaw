// Auth monitor tests cover notification delivery and optional helper script contracts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const NOW_SECONDS = 1_800_000_000;
const AUTH_MONITOR_PATH = "scripts/auth-monitor.sh";
const AUTH_MONITOR_SERVICE_PATH = "scripts/systemd/openclaw-auth-monitor.service";
const TERMUX_WIDGET_PATHS = ["scripts/termux-auth-widget.sh", "scripts/termux-quick-auth.sh"];

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

function createAuthMonitorHarness() {
  const home = tempDirs.make("openclaw-auth-monitor-");
  const binDir = join(home, "bin");
  const curlLog = join(home, "curl.log");
  const openclawLog = join(home, "openclaw.log");
  const stateFile = join(home, ".openclaw", "auth-monitor-state");
  const scriptsDir = join(home, "scripts");
  const statusFile = join(home, "status.json");
  let simpleStatus = "OK";
  let simpleExit = 0;
  mkdirSync(scriptsDir);
  writeFileSync(join(scriptsDir, "auth-monitor.sh"), readScript(AUTH_MONITOR_PATH));
  writeFileSync(
    join(scriptsDir, "claude-auth-status.sh"),
    [
      "#!/bin/sh",
      'if [ "$1" = json ]; then cat "$FAKE_AUTH_STATUS_FILE"; exit "$FAKE_AUTH_STATUS_EXIT"; fi',
      'printf "%s\\n" "$FAKE_AUTH_SIMPLE_STATUS"',
      'exit "$FAKE_AUTH_SIMPLE_EXIT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  function setStatus({
    nativeStatus = "OK:configured",
    nativeMessage,
    managedStatus = "OK:native",
    expiresAt = 0,
    simple = "OK",
    exit = 0,
  }: {
    nativeStatus?: string;
    nativeMessage?: string;
    managedStatus?: string;
    expiresAt?: number;
    simple?: string;
    exit?: number;
  } = {}) {
    writeFileSync(
      statusFile,
      JSON.stringify({
        claude_code: { status: nativeStatus, expires_at_ms: 0, message: nativeMessage },
        openclaw: { status: managedStatus, expires_at_ms: expiresAt },
        needs_reauth: exit === 1 || exit === 2,
      }),
    );
    simpleStatus = simple;
    simpleExit = exit;
  }
  setStatus();
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "date"),
    `#!/bin/sh\nif [ "$1" = "+%s" ]; then printf '%s\\n' '${NOW_SECONDS}'; else /bin/date "$@"; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "curl"),
    '#!/bin/sh\nprintf "called\\n" >> "$FAKE_CURL_LOG"\nexit "$FAKE_CURL_EXIT_CODE"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "openclaw"),
    [
      "#!/bin/sh",
      'if [ "$1" = "models" ]; then exit 64; fi',
      'if [ "$#" -ne 6 ] || [ "$1" != "message" ] || [ "$2" != "send" ] || [ "$3" != "--target" ] || [ "$5" != "--message" ]; then exit 64; fi',
      `jq -cn --arg target "$4" --arg message "$6" '{target:$target,message:$message}' >> "$FAKE_OPENCLAW_LOG"`,
      'exit "$FAKE_OPENCLAW_EXIT_CODE"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    curlLog,
    home,
    openclawLog,
    stateFile,
    setStatus,
    setManagedExpiry: (minutes = 90) => {
      setStatus({
        managedStatus: "EXPIRING",
        expiresAt: (NOW_SECONDS + minutes * 60) * 1000,
        simple: "OPENCLAW_EXPIRING",
        exit: 2,
      });
    },
    run: ({
      curlExitCode = 0,
      notifyNtfy = "test-topic",
      notifyPhone = "",
      openclawExitCode = 0,
      statusExitCode = 0,
      warnHours = 2,
    }: {
      curlExitCode?: number;
      notifyNtfy?: string;
      notifyPhone?: string;
      openclawExitCode?: number;
      statusExitCode?: number;
      warnHours?: number;
    } = {}) =>
      spawnSync("bash", [join(scriptsDir, "auth-monitor.sh")], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_AUTH_STATUS_FILE: statusFile,
          FAKE_AUTH_STATUS_EXIT: String(statusExitCode),
          FAKE_AUTH_SIMPLE_STATUS: simpleStatus,
          FAKE_AUTH_SIMPLE_EXIT: String(simpleExit),
          FAKE_CURL_EXIT_CODE: String(curlExitCode),
          FAKE_CURL_LOG: curlLog,
          FAKE_OPENCLAW_EXIT_CODE: String(openclawExitCode),
          FAKE_OPENCLAW_LOG: openclawLog,
          HOME: home,
          NOTIFY_NTFY: notifyNtfy,
          NOTIFY_PHONE: notifyPhone,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          WARN_HOURS: String(warnHours),
        },
      }),
  };
}

describe("auth monitoring scripts", () => {
  it("keeps public helper scripts free of private host defaults", () => {
    const privateHomePath = ["", "home", "admin"].join("/");
    const privateHostAlias = ["l", "36"].join("");
    const scripts = [AUTH_MONITOR_PATH, AUTH_MONITOR_SERVICE_PATH, ...TERMUX_WIDGET_PATHS].map(
      readScript,
    );
    const joined = scripts.join("\n");

    expect(joined).not.toContain(privateHomePath);
    expect(joined).not.toContain(privateHostAlias);
    for (const script of TERMUX_WIDGET_PATHS.map(readScript)) {
      expect(script).toContain('SERVER="${OPENCLAW_SERVER:-openclaw-host}"');
    }
  });

  it("bounds ntfy notification requests", () => {
    const script = readScript(AUTH_MONITOR_PATH);

    expect(script).toContain("curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null");
  });

  it("delivers a phone alert and rate-limits with 30 minutes left", () => {
    const harness = createAuthMonitorHarness();
    harness.setManagedExpiry(30);

    const delivered = harness.run({
      curlExitCode: 22,
      notifyPhone: "+15550000000",
    });
    expect(delivered.status).toBe(0);
    expect(existsSync(harness.stateFile)).toBe(true);
    expect(JSON.parse(readFileSync(harness.openclawLog, "utf8"))).toEqual({
      target: "+15550000000",
      message: "OpenClaw-managed auth expires in 0h 30m. Consider re-auth soon.",
    });

    const throttled = harness.run({
      curlExitCode: 22,
      notifyPhone: "+15550000000",
    });
    expect(throttled.stdout).toContain("Skipping notification (sent recently)");
    expect(readFileSync(harness.openclawLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(harness.curlLog, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("retries when all configured notification channels fail", () => {
    const harness = createAuthMonitorHarness();
    harness.setManagedExpiry();

    const failed = harness.run({
      curlExitCode: 22,
      notifyPhone: "+15550000000",
      openclawExitCode: 1,
    });
    expect(failed.status).toBe(0);
    expect(existsSync(harness.stateFile)).toBe(false);
    expect(failed.stderr).toContain("No notification delivered; cooldown not updated");

    const retry = harness.run({
      curlExitCode: 22,
      notifyPhone: "+15550000000",
      openclawExitCode: 1,
    });
    expect(retry.stdout).not.toContain("Skipping notification (sent recently)");
    expect(readFileSync(harness.openclawLog, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(harness.curlLog, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it.each(["OK:configured", "UNKNOWN"])(
    "does not notify for native %s with CLI-owned expiry",
    (nativeStatus) => {
      const harness = createAuthMonitorHarness();
      harness.setStatus({ nativeStatus });

      const result = harness.run({ notifyPhone: "+15550000000" });

      expect(result.status).toBe(0);
      expect(existsSync(harness.curlLog)).toBe(false);
      expect(existsSync(harness.openclawLog)).toBe(false);
      expect(existsSync(harness.stateFile)).toBe(false);
    },
  );

  it("notifies with the owner's recovery message for a definitely missing native login", () => {
    const harness = createAuthMonitorHarness();
    const nativeMessage =
      "Claude login missing. Run CLAUDE_CONFIG_DIR=/example/claude claude auth login";
    harness.setStatus({
      nativeStatus: "MISSING",
      nativeMessage,
      simple: "CLAUDE_EXPIRED",
      exit: 1,
    });

    const result = harness.run({ notifyPhone: "+15550000000" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(nativeMessage);
    expect(existsSync(harness.curlLog)).toBe(true);
    expect(existsSync(harness.openclawLog)).toBe(false);
    expect(existsSync(harness.stateFile)).toBe(true);
  });

  it("does not turn a failed status query into a login alert", () => {
    const harness = createAuthMonitorHarness();

    const result = harness.run({ statusExitCode: 3, notifyPhone: "+15550000000" });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Auth status unavailable");
    expect(existsSync(harness.curlLog)).toBe(false);
    expect(existsSync(harness.openclawLog)).toBe(false);
    expect(existsSync(harness.stateFile)).toBe(false);
  });

  it("uses WARN_HOURS for managed credentials rather than the helper's warning window", () => {
    const harness = createAuthMonitorHarness();
    harness.setManagedExpiry(90);

    const outsideWindow = harness.run({ warnHours: 1 });
    expect(outsideWindow.status).toBe(0);
    expect(existsSync(harness.curlLog)).toBe(false);

    const insideWindow = harness.run({ warnHours: 2 });
    expect(insideWindow.status).toBe(0);
    expect(insideWindow.stdout).toContain("OpenClaw-managed auth expires in 1h 30m");
    expect(existsSync(harness.stateFile)).toBe(true);
  });

  it("starts cooldown when ntfy succeeds even if phone delivery fails", () => {
    const harness = createAuthMonitorHarness();
    harness.setManagedExpiry();

    const result = harness.run({ notifyPhone: "+15550000000", openclawExitCode: 1 });

    expect(result.status).toBe(0);
    expect(existsSync(harness.openclawLog)).toBe(true);
    expect(existsSync(harness.curlLog)).toBe(true);
    expect(existsSync(harness.stateFile)).toBe(true);
  });

  it.each(["MISSING", "EXPIRED:1h"])("notifies for managed %s credentials", (managedStatus) => {
    const harness = createAuthMonitorHarness();
    harness.setStatus({ managedStatus, simple: "OPENCLAW_EXPIRED", exit: 1 });

    const result = harness.run({ notifyPhone: "+15550000000" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OpenClaw-managed auth missing or expired");
    expect(existsSync(harness.openclawLog)).toBe(false);
    expect(existsSync(harness.stateFile)).toBe(true);
  });

  it.each(["scripts/mobile-reauth.sh", ...TERMUX_WIDGET_PATHS])(
    "%s does not request login when status is unavailable",
    (script) => {
      const home = tempDirs.make("openclaw-auth-unknown-");
      const binDir = join(home, "bin");
      const toastLog = join(home, "toast.log");
      const scriptPath = join(home, "wrapper.sh");
      mkdirSync(binDir);
      writeFileSync(scriptPath, readScript(script));
      const unknownStatus = '#!/bin/sh\nprintf "UNKNOWN\\n"\nexit 3\n';
      writeFileSync(join(home, "claude-auth-status.sh"), unknownStatus, { mode: 0o755 });
      writeFileSync(join(binDir, "ssh"), unknownStatus, { mode: 0o755 });
      writeFileSync(
        join(binDir, "termux-toast"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_TOAST_LOG"\n',
        { mode: 0o755 },
      );
      for (const command of ["claude", "termux-open-url", "termux-dialog", "termux-vibrate"]) {
        writeFileSync(
          join(binDir, command),
          '#!/bin/sh\nprintf "unexpected auth action\\n" >&2\nexit 64\n',
          { mode: 0o755 },
        );
      }

      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_TOAST_LOG: toastLog,
        },
      });

      expect(result.status).toBe(script === "scripts/mobile-reauth.sh" ? 3 : 0);
      expect(result.stderr).not.toContain("unexpected auth action");
      const output = result.stdout + (existsSync(toastLog) ? readFileSync(toastLog, "utf8") : "");
      expect(output).toMatch(/[Aa]uth status (?:is )?unavailable/);
    },
  );

  it("persists user-local CLI and Node paths for the installed scheduled monitor", () => {
    const home = tempDirs.make("openclaw-auth-scheduler-");
    const scriptsDir = join(home, "scripts");
    const cliDir = join(home, ".npm-global", "bin");
    const nodeDir = join(home, "node", "bin");
    const binDir = join(home, "bin");
    const cliLog = join(home, "cli.log");
    for (const dir of [join(scriptsDir, "systemd"), cliDir, nodeDir, binDir]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const script of ["setup-auth-system.sh", "auth-monitor.sh", "claude-auth-status.sh"]) {
      writeFileSync(join(scriptsDir, script), readScript(`scripts/${script}`), { mode: 0o755 });
    }
    for (const unit of ["openclaw-auth-monitor.service", "openclaw-auth-monitor.timer"]) {
      writeFileSync(join(scriptsDir, "systemd", unit), readScript(`scripts/systemd/${unit}`));
    }
    writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(nodeDir, "node"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    const preparedStatus = {
      auth: {
        runtimeAuthRoutes: [
          {
            status: "usable",
            nativeAuth: { runtimeId: "claude-cli", mode: "oauth", readiness: "configured" },
          },
        ],
        oauth: { profiles: [] },
        providers: [],
      },
    };
    writeFileSync(
      join(cliDir, "openclaw"),
      [
        "#!/usr/bin/env node",
        `require("node:fs").appendFileSync(${JSON.stringify(cliLog)}, process.env.PATH + "\\n");`,
        `console.log(JSON.stringify(${JSON.stringify(preparedStatus)}));`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const installPath = `${cliDir}:${nodeDir}:${binDir}:${process.env.PATH ?? ""}`;
    const installed = spawnSync("bash", [join(scriptsDir, "setup-auth-system.sh")], {
      input: "n\n\n\n",
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: installPath },
    });
    expect(installed.status).toBe(0);
    const service = readFileSync(
      join(home, ".config", "systemd", "user", "openclaw-auth-monitor.service"),
      "utf8",
    );
    const [, scheduledPath = ""] = service.match(/^Environment="PATH=(.*)"$/m) ?? [];
    expect(scheduledPath).toBe(`${cliDir}:${nodeDir}:${installPath}`.replaceAll("%", "%%"));
    expect(service).not.toContain("@OPENCLAW_AUTH_MONITOR");
    writeFileSync(cliLog, "");

    const scheduled = spawnSync("/bin/bash", [join(scriptsDir, "auth-monitor.sh")], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: scheduledPath.replaceAll("%%", "%"),
        NOTIFY_NTFY: "",
        NOTIFY_PHONE: "",
      },
    });

    expect(scheduled.status).toBe(0);
    expect(readFileSync(cliLog, "utf8")).toContain(`${cliDir}:${nodeDir}:`);
    expect(scheduled.stdout).toContain("Auth OK");
  });
});
