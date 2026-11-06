// Real spawn/killProcessTree: fake gog leaves a SIGTERM-resistant child for shutdown to reap.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import {
  isProcessAlive as alive,
  waitForProcessExit,
} from "../../test/scripts/live-process-fixture.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startGmailWatcher, stopGmailWatcher } from "./gmail-watcher.js";
import { createGmailConfig } from "./gmail.test-support.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("gmail-watcher process-tree shutdown (integration)", () => {
  it("stopGmailWatcher removes gog and its credential-helper descendant", async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    const wait = <T>(work: Promise<T>) => withinTest(work, signal);
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
      `writeFileSync(${JSON.stringify(`${helperPidPath}.tmp`)}, [process.ppid, process.pid].join(" "));`,
      `renameSync(${JSON.stringify(`${helperPidPath}.tmp`)}, ${JSON.stringify(helperPidPath)});`,
      `sendReceipt(${JSON.stringify(helperPidPath)}, "ready");`,
    ]);

    const gogScript = join(tmpDir, "gog");
    writeScript(gogScript, [
      "#!/bin/bash",
      'case "$*" in',
      '  *"watch start"*) echo "[gog] watch registered"; exit 0 ;;',
      '  *"watch serve"*)',
      `    ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} &`,
      "    trap 'echo \"[gog] SIGTERM (child NOT killed)\"; exit 0' TERM",
      "    while true; do sleep 0.3; done ;;",
      "esac",
    ]);
    chmodSync(gogScript, 0o755);

    vi.stubEnv("PATH", `${tmpDir}:${process.env["PATH"] ?? ""}`);
    const result = await wait(
      startGmailWatcher(createGmailConfig("integration@example.com"), {
        scheduler: createTestGatewayScheduler(),
        signal,
      }),
    );

    expect(result.started).toBe(true);

    await wait(receipts.waitFor(helperPidPath, "ready"));

    pids.push(...readFileSync(helperPidPath, "utf8").split(" ").map(Number));
    expect(pids.map(alive)).toEqual([true, true]);

    await wait(stopGmailWatcher());

    // The watcher joins its leader and escalation, but exposes no descendant reap receipt.
    await Promise.all(pids.map((pid) => waitForProcessExit(pid, signal)));
    expect(pids.map(alive)).toEqual([false, false]);
  }, 15_000);
});
