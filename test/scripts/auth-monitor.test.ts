// Auth monitor tests cover optional systemd and Termux helper script contracts.
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
      'if [ "$1" = "models" ]; then exit 1; fi',
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
    enablePhoneAuth: (minutes = 90) => {
      const expiresAt = (NOW_SECONDS + minutes * 60) * 1000;
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".openclaw", "agents", "main", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { expiresAt } }),
      );
      writeFileSync(
        join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
        JSON.stringify({
          profiles: { "anthropic:default": { expires: expiresAt, provider: "anthropic" } },
        }),
      );
    },
    run: ({
      curlExitCode = 0,
      notifyNtfy = "test-topic",
      notifyPhone = "",
      openclawExitCode = 0,
    }: {
      curlExitCode?: number;
      notifyNtfy?: string;
      notifyPhone?: string;
      openclawExitCode?: number;
    } = {}) =>
      spawnSync("bash", [AUTH_MONITOR_PATH], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_EXIT_CODE: String(curlExitCode),
          FAKE_CURL_LOG: curlLog,
          FAKE_OPENCLAW_EXIT_CODE: String(openclawExitCode),
          FAKE_OPENCLAW_LOG: openclawLog,
          HOME: home,
          NOTIFY_NTFY: notifyNtfy,
          NOTIFY_PHONE: notifyPhone,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          WARN_HOURS: "2",
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
    expect(joined).toContain("Run on the OpenClaw host: ${SCRIPT_DIR}/mobile-reauth.sh");
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
    harness.enablePhoneAuth(30);

    const delivered = harness.run({
      curlExitCode: 22,
      notifyPhone: "+15550000000",
    });
    expect(delivered.status).toBe(0);
    expect(existsSync(harness.stateFile)).toBe(true);
    expect(JSON.parse(readFileSync(harness.openclawLog, "utf8"))).toEqual({
      target: "+15550000000",
      message: "Claude Code auth expires in 0h 30m. Consider re-auth soon.",
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
    harness.enablePhoneAuth();

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
});
