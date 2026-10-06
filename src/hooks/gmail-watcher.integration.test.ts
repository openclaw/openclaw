/**
 * Runs startGmailWatcher and stopGmailWatcher with NO mocks for spawn or
 * killProcessTree. A fake `gog` binary is placed on PATH; it spawns a
 * credential-helper child and deliberately does NOT kill it on SIGTERM,
 * simulating the real bug. The test asserts that stopGmailWatcher removes
 * both the gog process and its descendant via the process-group signal.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startGmailWatcher, stopGmailWatcher } from "./gmail-watcher.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describePosix("gmail-watcher process-tree shutdown (integration)", () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let gogPid: number | undefined;
  let helperPid: number | undefined;
  let receipts: FixtureReceiptChannel;

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-gog-integration-"));

    const helperPath = join(tmpDir, "credential-helper.mjs");
    const helperPidPath = join(tmpDir, "helper.pid");
    writeFileSync(
      helperPath,
      [
        fixtureReceiptClientSource(receipts.endpoint),
        'import { renameSync, writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
        `writeFileSync(${JSON.stringify(`${helperPidPath}.tmp`)}, String(process.pid));`,
        `renameSync(${JSON.stringify(`${helperPidPath}.tmp`)}, ${JSON.stringify(helperPidPath)});`,
        `sendReceipt(${JSON.stringify(helperPidPath)}, "ready");`,
      ].join("\n"),
    );

    // fake gog: handles `watch start` (exits 0) and `watch serve`
    // (spawns a credential-helper that ignores SIGTERM)
    const gogScript = join(tmpDir, "gog");
    writeFileSync(
      gogScript,
      [
        "#!/bin/bash",
        'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
        'case "$*" in',
        '  *"watch start"*) echo "[gog] watch registered"; exit 0 ;;',
        '  *"watch serve"*)',
        '    echo "[gog] serve started pid=$$"',
        // The helper reports readiness only after both complete PID files exist.
        '    echo $$ > "$SCRIPT_DIR/gog.pid.tmp"',
        '    mv "$SCRIPT_DIR/gog.pid.tmp" "$SCRIPT_DIR/gog.pid"',
        `    ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} &`,
        "    HELPER=$!",
        '    echo "[gog] credential-helper spawned pid=$HELPER"',
        "    trap 'echo \"[gog] SIGTERM (child NOT killed)\"; exit 0' TERM",
        "    while true; do sleep 0.3; done ;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(gogScript, 0o755);

    savedPath = process.env["PATH"];
    process.env["PATH"] = `${tmpDir}:${savedPath ?? ""}`;
  });

  afterAll(async () => {
    try {
      await stopGmailWatcher();
    } catch {
      // Force cleanup below; this test must not leave subprocesses behind on failure.
    }
    if (gogPid !== undefined) {
      try {
        process.kill(-gogPid, "SIGKILL");
      } catch {
        // The process group may already be gone.
      }
    }
    if (helperPid !== undefined) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {
        // The helper may already be gone with its process group.
      }
    }
    if (savedPath !== undefined) {
      process.env["PATH"] = savedPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    await receipts?.close();
  });

  it("stopGmailWatcher removes gog and its credential-helper descendant", async ({ signal }) => {
    const result = await withinTest(
      startGmailWatcher(
        {
          hooks: {
            enabled: true,
            token: "integration-token",
            gmail: {
              account: "integration@example.com",
              topic: "projects/integration/topics/gmail",
              pushToken: "integration-push-token",
            },
          },
        },
        { scheduler: createTestGatewayScheduler(), signal },
      ),
      signal,
    );

    expect(result.started).toBe(true);

    await withinTest(receipts.waitFor(join(tmpDir, "helper.pid"), "ready"), signal);

    gogPid = Number.parseInt(readFileSync(join(tmpDir, "gog.pid"), "utf8").trim(), 10);
    helperPid = Number.parseInt(readFileSync(join(tmpDir, "helper.pid"), "utf8").trim(), 10);

    console.log(`\ngog pid=${gogPid}, credential-helper pid=${helperPid}`);
    expect(alive(gogPid)).toBe(true);
    expect(alive(helperPid)).toBe(true);

    console.log("calling stopGmailWatcher...");
    await withinTest(stopGmailWatcher(), signal);

    // The watcher joins its leader and escalation, but exposes no descendant reap receipt.
    while (alive(gogPid) || alive(helperPid)) {
      await delay(25, undefined, { signal }).catch((error: unknown) => {
        throw new Error(`Gmail watcher tree ${gogPid}/${helperPid} stayed alive`, { cause: error });
      });
    }
    expect(alive(gogPid)).toBe(false);
    expect(alive(helperPid)).toBe(false);

    console.log(`gog alive after stop: ${alive(gogPid)}`);
    console.log(`credential-helper alive after stop: ${alive(helperPid)}`);
  }, 15_000);
});
