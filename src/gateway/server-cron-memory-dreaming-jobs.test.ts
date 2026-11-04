import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearCronJobActive, markCronJobActive } from "../cron/active-jobs.js";
import { runCronCommandJob } from "../cron/command-runner.js";
import { cronTestDeps, cronTestInput } from "../cron/service.fixture-builders.test-support.js";
import { CronService } from "../cron/service.js";
import * as runtimeMutation from "../cron/service/runtime-mutation.js";
import { withCronStore } from "../cron/store.worker.test-support.js";
import type { CronEvent } from "../cron/types.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayCronReconciliation } from "./server-cron-reconciled.js";
import { createTestCronState } from "./server-reload-handlers.config.test-support.js";

it.each([
  "current",
  "config",
  "registry",
  "closing",
  "reload",
  "enabled",
  "missing inventory",
] as const)("revalidates cleanup ownership at worker dispatch: %s", async (mode) => {
  await withCronStore("dreaming-cleanup-commit", async ({ storePath, load }) => {
    let cfg: OpenClawConfig = {
      plugins: {
        slots: { memory: "memory-owner" },
        entries: {
          "memory-owner": { enabled: true, config: { dreaming: { enabled: mode === "enabled" } } },
        },
      },
    };
    let registry = createEmptyPluginRegistry();
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    if (mode !== "missing inventory") {
      setPluginRuntimeLoadContext(registry, {
        rawConfig: cfg,
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: undefined,
        env: {},
        logger,
        manifestRegistry: {
          plugins: ["memory-owner", "memory-core"].map((id) =>
            createPluginManifestRecordFixture({ id, kind: "memory" }),
          ),
          diagnostics: [],
        },
      });
    }
    const cron = new CronService(cronTestDeps({ storePath, cronEnabled: false }));
    const created = await cron.add(
      cronTestInput({
        enabled: false,
        declarationKey: "memory-core:memory-dreaming-promotion",
        owner: { agentId: "main", sessionKey: "agent:main:main" },
      }),
    );
    const marker = markCronJobActive(created.id);
    if (!marker) {
      throw new Error("missing active marker");
    }
    let closing = false;
    const runHook = vi.fn(async () => {});
    const reconciliation = createGatewayCronReconciliation({
      port: 0,
      workspaceDir: "",
      getConfig: () => cfg,
      getPluginRegistry: () => registry,
      logger,
      isClosing: () => closing,
      runHook,
    });
    const armed = reconciliation.arm({
      reason: "startup",
      config: cfg,
      cronState: { ...createTestCronState(), cron, storePath, cronEnabled: false },
    });
    const execute = runtimeMutation.runCronRuntimeMutation;
    let removals = 0;
    const observer = vi
      .spyOn(runtimeMutation, "runCronRuntimeMutation")
      .mockImplementation(async (params) => {
        if (params.type === "cron.mutateJobs") {
          removals++;
          if (mode === "config") {
            cfg = {};
          }
          if (mode === "registry") {
            registry = createEmptyPluginRegistry();
          }
          if (mode === "closing") {
            closing = true;
          }
          if (mode === "reload") {
            reconciliation.invalidate();
          }
        }
        return execute(params);
      });
    try {
      await armed.complete();
    } finally {
      observer.mockRestore();
      cron.stop();
    }
    const remains = (await load()).store.jobs.some((job) => job.id === created.id);
    try {
      expect(remains).toBe(mode !== "current");
      if (mode !== "enabled" && mode !== "missing inventory") {
        expect(removals).toBe(1);
      }
      expect(marker.jobRemoved === true).toBe(mode === "current");
      expect(marker.cancellation?.kind === "requested").toBe(mode === "current");
    } finally {
      clearCronJobActive(created.id, marker);
    }
  });
});

it("settles a real running command when orphan cleanup removes its declaration", async () => {
  await withCronStore("dreaming-running-cleanup", async ({ storePath, load }) => {
    const cfg: OpenClawConfig = {
      plugins: {
        slots: { memory: "memory-owner" },
        entries: {
          "memory-owner": { enabled: true, config: { dreaming: { enabled: false } } },
        },
      },
    };
    const registry = createEmptyPluginRegistry();
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    setPluginRuntimeLoadContext(registry, {
      rawConfig: cfg,
      config: cfg,
      activationSourceConfig: cfg,
      autoEnabledReasons: {},
      workspaceDir: undefined,
      env: {},
      logger,
      manifestRegistry: {
        plugins: ["memory-owner", "memory-core"].map((id) =>
          createPluginManifestRecordFixture({ id, kind: "memory" }),
        ),
        diagnostics: [],
      },
    });
    const events: CronEvent[] = [];
    const cron = new CronService(
      cronTestDeps({
        storePath,
        cronEnabled: false,
        scheduler: createTestGatewayScheduler("fake-timers"),
        runCommandJob: runCronCommandJob,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const pidPath = path.join(path.dirname(storePath), "command.pid");
    const created = await cron.add(
      cronTestInput({
        enabled: false,
        declarationKey: "memory-core:memory-dreaming-promotion",
        owner: { agentId: "main", sessionKey: "agent:main:main" },
        delivery: { mode: "none" },
        payload: {
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync(" +
              JSON.stringify(pidPath) +
              ", String(process.pid));setInterval(() => {}, 1000)",
          ],
          timeoutSeconds: 30,
        },
      }),
    );
    const running = cron.run(created.id, "force").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let pid = 0;
    try {
      await expect
        .poll(
          async () => {
            pid = Number(await fs.readFile(pidPath, "utf8").catch(() => "0"));
            return pid > 0 && isPidAlive(pid);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const reconciliation = createGatewayCronReconciliation({
        port: 0,
        workspaceDir: "",
        getConfig: () => cfg,
        getPluginRegistry: () => registry,
        logger,
        isClosing: () => false,
        runHook: async () => {},
      });
      await reconciliation
        .arm({
          reason: "reload",
          config: cfg,
          cronState: { ...createTestCronState(), cron, storePath, cronEnabled: false },
        })
        .complete();
      expect((await load()).store.jobs.some((job) => job.id === created.id)).toBe(false);
      expect(await running).not.toHaveProperty("error");
      await expect.poll(() => isPidAlive(pid), { timeout: 10_000 }).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          jobId: created.id,
          action: "finished",
          status: "error",
          error: "Cron job removed by operator.",
        }),
      );
    } finally {
      await cron.remove(created.id);
      await running;
      cron.stop();
      await cron.waitForIdle();
    }
  });
}, 45_000);
