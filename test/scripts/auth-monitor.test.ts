import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const NOW_SECONDS = 1_800_000_000;
const AUTH_MONITOR_PATH = "scripts/auth-monitor.sh";
const AUTH_MONITOR_SERVICE_PATH = "scripts/systemd/openclaw-auth-monitor.service";
const TERMUX_WIDGET_PATHS = ["scripts/termux-auth-widget.sh", "scripts/termux-quick-auth.sh"];

const readScript = (file: string) => readFileSync(file, "utf8");

function createAuthMonitorHarness(minutes = 90) {
  const home = tempDirs.make("openclaw-auth-monitor-");
  const binDir = join(home, "bin");
  const curlLog = join(home, "curl.log");
  const openclawLog = join(home, "openclaw.log");
  mkdirSync(binDir);
  const tool = (name: string, script: string) =>
    writeFileSync(join(binDir, name), script, { mode: 0o755 });
  tool(
    "date",
    `#!/bin/sh\nif [ "$1" = "+%s" ]; then printf '%s\\n' '${NOW_SECONDS}'; else /bin/date "$@"; fi\n`,
  );
  tool("curl", '#!/bin/sh\nprintf "called\\n" >> "$FAKE_CURL_LOG"\nexit "$FAKE_CURL_EXIT_CODE"\n');
  tool(
    "openclaw",
    [
      "#!/bin/sh",
      'if [ "$1" = "models" ]; then exit 1; fi',
      'if [ "$#" -ne 6 ] || [ "$1" != "message" ] || [ "$2" != "send" ] || [ "$3" != "--target" ] || [ "$5" != "--message" ]; then exit 64; fi',
      `jq -cn --arg target "$4" --arg message "$6" '{target:$target,message:$message}' >> "$FAKE_OPENCLAW_LOG"`,
      'exit "$FAKE_OPENCLAW_EXIT_CODE"',
      "",
    ].join("\n"),
  );
  const expiresAt = (NOW_SECONDS + minutes * 60) * 1000;
  const put = (relative: string, value: unknown) => {
    const file = join(home, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  put(".claude/.credentials.json", { claudeAiOauth: { expiresAt } });
  put(".openclaw/agents/main/agent/auth-profiles.json", {
    profiles: { "anthropic:default": { expires: expiresAt, provider: "anthropic" } },
  });

  return {
    readAlert: () => JSON.parse(readFileSync(openclawLog, "utf8")),
    hasCooldown: () => existsSync(join(home, ".openclaw", "auth-monitor-state")),
    notificationCounts: () =>
      [openclawLog, curlLog].map((file) => readFileSync(file, "utf8").trim().split("\n").length),
    run: (openclawExitCode = 0) =>
      spawnSync("bash", [AUTH_MONITOR_PATH], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_EXIT_CODE: "22",
          FAKE_CURL_LOG: curlLog,
          FAKE_OPENCLAW_EXIT_CODE: String(openclawExitCode),
          FAKE_OPENCLAW_LOG: openclawLog,
          HOME: home,
          NOTIFY_NTFY: "test-topic",
          NOTIFY_PHONE: "+15550000000",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          WARN_HOURS: "2",
        },
      }),
  };
}

it("keeps public helper scripts free of private host defaults", () => {
  const joined = [AUTH_MONITOR_PATH, AUTH_MONITOR_SERVICE_PATH, ...TERMUX_WIDGET_PATHS]
    .map(readScript)
    .join("\n");

  expect(joined).not.toContain(["", "home", "admin"].join("/"));
  expect(joined).not.toContain(["l", "36"].join(""));
  expect(joined).toContain("Run on the OpenClaw host: ${SCRIPT_DIR}/mobile-reauth.sh");
  for (const script of TERMUX_WIDGET_PATHS.map(readScript)) {
    expect(script).toContain('SERVER="${OPENCLAW_SERVER:-openclaw-host}"');
  }
});

it("bounds ntfy notification requests", () => {
  expect(readScript(AUTH_MONITOR_PATH)).toContain(
    "curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null",
  );
});

it("delivers a phone alert and rate-limits with 30 minutes left", () => {
  const harness = createAuthMonitorHarness(30);

  expect(harness.run().status).toBe(0);
  expect(harness.hasCooldown()).toBe(true);
  expect(harness.readAlert()).toEqual({
    target: "+15550000000",
    message: "Claude Code auth expires in 0h 30m. Consider re-auth soon.",
  });

  const throttled = harness.run();
  expect(throttled.stdout).toContain("Skipping notification (sent recently)");
  expect(harness.notificationCounts()).toEqual([1, 1]);
});

it("retries when all configured notification channels fail", () => {
  const harness = createAuthMonitorHarness();

  const failed = harness.run(1);
  expect(failed.status).toBe(0);
  expect(harness.hasCooldown()).toBe(false);
  expect(failed.stderr).toContain("No notification delivered; cooldown not updated");

  const retry = harness.run(1);
  expect(retry.stdout).not.toContain("Skipping notification (sent recently)");
  expect(harness.notificationCounts()).toEqual([2, 2]);
});
