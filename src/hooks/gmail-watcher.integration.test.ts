// Real spawn/killProcessTree: fake gog leaves a SIGTERM-resistant child for shutdown to reap.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import gmailPlugin from "../../extensions/gmail/index.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import {
  isProcessAlive as alive,
  waitForProcessExit,
} from "../../test/scripts/live-process-fixture.test-support.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { PluginServiceRegistration } from "../plugins/registry-types.js";
import { createRegistry, startPluginServices } from "../plugins/services.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGmailConfig } from "./gmail.test-support.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("Gmail plugin service (integration)", () => {
  it("passes tokens to Gog without argv leakage and reaps its process tree on stop", async ({
    signal,
  }) => {
    const receipts = await openFixtureReceiptChannel();
    const wait = <T>(work: Promise<T>) => withinTest(work, signal);
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-gog-integration-"));
    const pids: number[] = [];
    const pushToken = randomBytes(24).toString("hex");
    const hookToken = randomBytes(24).toString("hex");
    const transportReceipt = join(tmpDir, "transport.json");
    const scheduler = createTestGatewayScheduler("fake-timers");
    let stop: (() => Promise<void>) | undefined;
    onTestFinished(async () => {
      try {
        await stop?.();
      } catch {
        // Still force cleanup when watcher shutdown fails.
      }
      await scheduler.stop();
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
      `writeFileSync(${JSON.stringify(transportReceipt)}, JSON.stringify({
        push: process.env.OPENCLAW_GOG_WATCH_PUSH_TOKEN === ${JSON.stringify(pushToken)},
        hook: process.env.OPENCLAW_GOG_WATCH_HOOK_TOKEN === ${JSON.stringify(hookToken)},
        argvClean: !process.argv.some(arg => arg.includes(${JSON.stringify(pushToken)}) || arg.includes(${JSON.stringify(hookToken)}))
      }));`,
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
      '  *"schema gmail watch serve"*) echo \'{ "schema_version": 1, "command": { "type": "command", "name": "serve", "flags": [{"name":"token","type":"string"},{"name":"hook-token","type":"string"},{"name":"token-env","type":"string"},{"name":"hook-token-env","type":"string"}] } }\'; exit 0 ;;',
      '  *"watch start"*) echo "[gog] watch registered"; exit 0 ;;',
      '  *"watch serve"*)',
      `    ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} "$@" &`,
      "    trap 'echo \"[gog] SIGTERM (child NOT killed)\"; exit 0' TERM",
      "    while true; do sleep 0.3; done ;;",
      "esac",
    ]);
    chmodSync(gogScript, 0o755);

    vi.stubEnv("PATH", `${tmpDir}:${process.env["PATH"] ?? ""}`);
    const config = createGmailConfig("integration@example.com");
    config.hooks!.token = hookToken;
    config.hooks!.gmail!.pushToken = pushToken;
    vi.stubEnv("OPENCLAW_SKIP_GMAIL_WATCHER", undefined);
    const services: PluginServiceRegistration["service"][] = [];
    gmailPlugin.register(
      createTestPluginApi({
        id: "gmail",
        config,
        registerService: (service) => {
          services.push(service);
        },
      }),
    );
    const handle = await wait(
      startPluginServices({
        config,
        scheduler,
        registry: createRegistry(services, "gmail", "bundled"),
      }),
    );
    if (!handle) {
      throw new Error("Gmail did not register a plugin service");
    }
    stop = async () => {
      await handle.stop({ strict: true });
    };

    await wait(receipts.waitFor(helperPidPath, "ready"));

    pids.push(...readFileSync(helperPidPath, "utf8").split(" ").map(Number));
    expect(pids.map(alive)).toEqual([true, true]);
    expect(JSON.parse(readFileSync(transportReceipt, "utf8"))).toEqual({
      push: true,
      hook: true,
      argvClean: true,
    });

    await wait(stop());

    // The watcher joins its leader and escalation, but exposes no descendant reap receipt.
    await Promise.all(pids.map((pid) => waitForProcessExit(pid, signal)));
    expect(pids.map(alive)).toEqual([false, false]);
  }, 15_000);
});
