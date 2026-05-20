import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("scripts/verify-gesahni-bridge.sh");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createCurlMock(tmpDir: string, responses: Record<string, string>) {
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "curl.log");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logPath, "", "utf8");
  writeExecutable(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
printf '%s\n' "$url" >> ${JSON.stringify(logPath)}
case "$url" in
${Object.entries(responses)
  .map(
    ([url, body]) => `  ${JSON.stringify(url)})\n    printf '%s' ${JSON.stringify(body)}\n    ;;`,
  )
  .join("\n")}
  *)
    echo "unexpected url: $url" >&2
    exit 1
    ;;
esac
`,
  );
  return { binDir, logPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify-gesahni-bridge script", () => {
  it("uses live alert and watch rule ids instead of demo placeholders", () => {
    const tmpDir = makeTempDir("gesahni-verify-");
    const { binDir, logPath } = createCurlMock(tmpDir, {
      "http://bridge.test/health": "{}",
      "http://bridge.test/v1/bridge/watchlist": '{"watchlist":["SPY"],"count":1}',
      "http://bridge.test/v1/bridge/positions": '{"positions":[],"count":0}',
      "http://bridge.test/v1/bridge/market/summary": '{"market_hours":{"is_open":true}}',
      "http://bridge.test/v1/bridge/alerts":
        '{"alerts":[{"id":"alert-live-1","ticker":"SPY"}],"count":1}',
      "http://bridge.test/v1/bridge/earnings/upcoming?days=14": '{"events":[],"count":0}',
      "http://bridge.test/v1/bridge/portfolio": '{"holdings":[],"count":0}',
      "http://bridge.test/v1/bridge/options/positions": '{"positions":[],"count":0}',
      "http://bridge.test/v1/bridge/options/watch_rules":
        '{"watch_rules":[{"id":"rule-live-1"}],"count":1}',
      "http://bridge.test/v1/bridge/options/status": '{"status":"ok"}',
      "http://bridge.test/v1/bridge/options/alert_suggestions": '{"items":[],"count":0}',
      "http://bridge.test/v1/bridge/options/chain_snapshot?symbol=AAPL": '{"expirations":[]}',
      "http://bridge.test/v1/bridge/options/quotes_batch?symbols=AAPL,MSFT":
        '{"quotes":[],"count":0}',
      "http://bridge.test/v1/bridge/earnings/coverage": '{"covered":0,"uncovered":0,"total":0}',
      "http://bridge.test/v1/bridge/earnings/reminders/due": '{"reminders":[],"count":0}',
      "http://bridge.test/v1/bridge/earnings/reminders/sent": '{"reminders":[],"count":0}',
      "http://bridge.test/v1/bridge/alerts/alert-live-1/deliveries": '{"deliveries":[],"count":0}',
      "http://bridge.test/v1/bridge/options/watch_rules/rule-live-1/events":
        '{"items":[],"count":0}',
    });

    const result = spawnSync("bash", [SCRIPT_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GESAHNI_BASE_URL: "http://bridge.test",
        GESAHNI_READ_BRIDGE_TOKEN: "bridge-token",
        GESAHNI_TEST_CHAT_ID: "7975901790",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS bridge_alert_deliveries");
    expect(result.stdout).toContain("PASS bridge_options_watch_rule_events");
    const curlLog = readFileSync(logPath, "utf8");
    expect(curlLog).toContain("http://bridge.test/health");
    expect(curlLog).toContain("http://bridge.test/v1/bridge/alerts/alert-live-1/deliveries");
    expect(curlLog).toContain(
      "http://bridge.test/v1/bridge/options/watch_rules/rule-live-1/events",
    );
    expect(curlLog).not.toContain("/alerts/demo/deliveries");
    expect(curlLog).not.toContain("/watch_rules/demo/events");
  });

  it("skips alert and watch rule detail checks when no ids are available", () => {
    const tmpDir = makeTempDir("gesahni-verify-skip-");
    const { binDir } = createCurlMock(tmpDir, {
      "http://bridge.test/health": "{}",
      "http://bridge.test/v1/bridge/watchlist": '{"watchlist":[],"count":0}',
      "http://bridge.test/v1/bridge/positions": '{"positions":[],"count":0}',
      "http://bridge.test/v1/bridge/market/summary": '{"market_hours":{"is_open":true}}',
      "http://bridge.test/v1/bridge/alerts": '{"alerts":[],"count":0}',
      "http://bridge.test/v1/bridge/earnings/upcoming?days=14": '{"events":[],"count":0}',
      "http://bridge.test/v1/bridge/portfolio": '{"holdings":[],"count":0}',
      "http://bridge.test/v1/bridge/options/positions": '{"positions":[],"count":0}',
      "http://bridge.test/v1/bridge/options/watch_rules": '{"watch_rules":[],"count":0}',
      "http://bridge.test/v1/bridge/options/status": '{"status":"ok"}',
      "http://bridge.test/v1/bridge/options/alert_suggestions": '{"items":[],"count":0}',
      "http://bridge.test/v1/bridge/options/chain_snapshot?symbol=AAPL": '{"expirations":[]}',
      "http://bridge.test/v1/bridge/options/quotes_batch?symbols=AAPL,MSFT":
        '{"quotes":[],"count":0}',
      "http://bridge.test/v1/bridge/earnings/coverage": '{"covered":0,"uncovered":0,"total":0}',
      "http://bridge.test/v1/bridge/earnings/reminders/due": '{"reminders":[],"count":0}',
      "http://bridge.test/v1/bridge/earnings/reminders/sent": '{"reminders":[],"count":0}',
    });

    const result = spawnSync("bash", [SCRIPT_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GESAHNI_BASE_URL: "http://bridge.test",
        GESAHNI_READ_BRIDGE_TOKEN: "bridge-token",
        GESAHNI_TEST_CHAT_ID: "7975901790",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP bridge_alert_deliveries (no alerts available)");
    expect(result.stdout).toContain(
      "SKIP bridge_options_watch_rule_events (no watch rules available)",
    );
    expect(result.stdout).toContain("Summary: PASS=16 FAIL=0 SKIP=2");
  });
});
