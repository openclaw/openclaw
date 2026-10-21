// Real spawn/killProcessTree: fake gog leaves a SIGTERM-resistant child for shutdown to reap.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
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
  it("stopGmailWatcher removes gog and its credential-helper descendant", async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-gog-integration-"));
    const pids: number[] = [];
    onTestFinished(async () => {
      try {
        await stopGmailWatcher();
      } catch {
        // Still force cleanup when watcher shutdown fails.
      }
      for (const [index, pid] of pids.entries()) {
        try {
          process.kill(index === 0 ? -pid : pid, "SIGKILL");
        } catch {
          // The process/group may already be gone.
        }
      }
      vi.unstubAllEnvs();
      rmSync(tmpDir, { recursive: true, force: true });
      await receipts.close();
    });

    const helperPath = join(tmpDir, "credential-helper.mjs");
    const helperPidPath = join(tmpDir, "helper.pid");
    const writeScript = (filePath: string, lines: string[]) =>
      writeFileSync(filePath, lines.join("\n"));
    writeScript(helperPath, [
      fixtureReceiptClientSource(receipts.endpoint),
      'import { renameSync, writeFileSync } from "node:fs";',
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
      `writeFileSync(${JSON.stringify(`${helperPidPath}.tmp`)}, String(process.pid));`,
      `renameSync(${JSON.stringify(`${helperPidPath}.tmp`)}, ${JSON.stringify(helperPidPath)});`,
      `sendReceipt(${JSON.stringify(helperPidPath)}, "ready");`,
    ]);

    const gogScript = join(tmpDir, "gog");
    writeScript(gogScript, [
      "#!/bin/bash",
      'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
      'case "$*" in',
      '  *"watch start"*) echo "[gog] watch registered"; exit 0 ;;',
      '  *"watch serve"*)',
      // The helper reports readiness only after both complete PID files exist.
      '    echo $$ > "$SCRIPT_DIR/gog.pid.tmp"',
      '    mv "$SCRIPT_DIR/gog.pid.tmp" "$SCRIPT_DIR/gog.pid"',
      `    ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} &`,
      "    trap 'echo \"[gog] SIGTERM (child NOT killed)\"; exit 0' TERM",
      "    while true; do sleep 0.3; done ;;",
      "esac",
    ]);
    chmodSync(gogScript, 0o755);

    vi.stubEnv("PATH", `${tmpDir}:${process.env["PATH"] ?? ""}`);
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

    for (const name of ["gog", "helper"]) {
      pids.push(Number.parseInt(readFileSync(join(tmpDir, `${name}.pid`), "utf8").trim(), 10));
    }
    expect(pids.map(alive)).toEqual([true, true]);

    await withinTest(stopGmailWatcher(), signal);

    // The watcher joins its leader and escalation, but exposes no descendant reap receipt.
    while (pids.some(alive)) {
      await delay(25, undefined, { signal }).catch((error: unknown) => {
        throw new Error(`Gmail watcher tree ${pids.join("/")} stayed alive`, { cause: error });
      });
    }
    expect(pids.map(alive)).toEqual([false, false]);
  }, 15_000);
});
