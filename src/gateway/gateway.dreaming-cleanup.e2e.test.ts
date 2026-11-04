import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronTestDeps, cronTestInput } from "../cron/service.fixture-builders.test-support.js";
import { CronService } from "../cron/service.js";
import { loadCronStore, resolveCronStorePathAsync } from "../cron/store.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const key = "memory-core:memory-dreaming-promotion";

it("cleans orphan declarations through reload, running-job cancellation, and restart", async () => {
  const home = tempDirs.make("openclaw-dreaming-cleanup-");
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace);
  const certPath = path.join(home, "cert.pem");
  const keyPath = path.join(home, "key.pem");
  await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
  await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
  for (const name of [
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
    "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    "OPENCLAW_SKIP_CRON",
  ]) {
    vi.stubEnv(name, undefined);
  }
  for (const name of [
    "CHANNELS",
    "GMAIL_WATCHER",
    "CANVAS_HOST",
    "BROWSER_CONTROL_SERVER",
    "PROVIDERS",
  ]) {
    vi.stubEnv(`OPENCLAW_SKIP_${name}`, "1");
  }
  const config: OpenClawConfig = {
    logging: { level: "debug", consoleLevel: "error", file: path.join(home, "gateway.log") },
    agents: {
      ownership: "explicit",
      defaults: { workspace, skipBootstrap: true, systemAgent: { agentId: "main" } },
      entries: { main: {} },
    },
    gateway: {
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
        },
        identityScopes: { "dreaming@example.test": ["operator.admin"] },
      },
      controlUi: { allowedOrigins: ["https://control.example.test"] },
      tls: { enabled: true, autoGenerate: false, certPath, keyPath },
    },
    cron: { enabled: false },
    plugins: {
      allow: ["memory-lancedb", "memory-core"],
      slots: { memory: "memory-lancedb" },
      entries: {
        "memory-lancedb": {
          enabled: true,
          config: {
            embedding: { apiKey: "fixture-key" },
            dbPath: path.join(home, "lancedb"),
            autoCapture: false,
            autoRecall: false,
            dreaming: { enabled: false },
          },
        },
      },
    },
  };
  const storePath = await resolveCronStorePathAsync();
  const seed = new CronService(cronTestDeps({ storePath, cronEnabled: false }));
  const base = cronTestInput({
    enabled: false,
    owner: { agentId: "main", sessionKey: "agent:main:main" },
    delivery: { mode: "none" },
  });
  const managed = await seed.add({ ...base, declarationKey: key });
  const authored = await seed.add({
    ...base,
    name: "Memory Dreaming Promotion",
    payload: { kind: "agentTurn", message: "Authored control" },
  });
  const historical = await seed.add({
    ...base,
    name: "Memory Light Dreaming",
    payload: { kind: "agentTurn", message: "__openclaw_memory_core_light_sleep__" },
  });
  seed.stop();
  expect((await loadCronStore(storePath)).jobs).toHaveLength(3);
  const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
  const start = (cfg: OpenClawConfig) =>
    startGatewayWithClient({
      cfg,
      hotReloadRecovery,
      configPath: path.join(home, "openclaw.json"),
      auth: config.gateway!.auth,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      secure: true,
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
      edgeAuthHeaders: {
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "dreaming@example.test",
      },
      origin: "https://control.example.test",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
  let gateway = await start(config);
  let runningJobId: string | undefined;
  try {
    await gateway.server.startupSettled;
    expect(getRuntimeConfig().plugins?.entries?.["memory-lancedb"]?.config?.dreaming).toEqual({
      enabled: false,
    });
    expect(
      getActivePluginRegistry()?.plugins.some(
        (plugin) => plugin.id === "memory-core" && plugin.status === "loaded",
      ),
    ).toBe(false);
    await expect
      .poll(async () => (await loadCronStore(storePath)).jobs.map((job) => job.id), {
        timeout: 10_000,
      })
      .toEqual(expect.not.arrayContaining([managed.id]));
    const remaining = (await loadCronStore(storePath)).jobs.map((job) => job.id);
    expect(remaining).toEqual(expect.arrayContaining([authored.id, historical.id]));
    const managedJobs = async () =>
      (await loadCronStore(storePath)).jobs.filter((job) => job.declarationKey === key);
    // Service startup intentionally skips declaration creation while cron is paused.
    // Resume that scheduler before loading the sidecar, rather than waiting for its minute tick.
    const beforeResume = await gateway.client.request<{ hash: string }>("config.get", {});
    await gateway.client.request("config.patch", {
      baseHash: beforeResume.hash,
      raw: JSON.stringify({ cron: { enabled: true } }),
    });
    await expect
      .poll(
        async () => (await gateway.client.request<{ enabled: boolean }>("cron.status", {})).enabled,
        { timeout: 20_000 },
      )
      .toBe(true);
    const toggle = async (enabled: boolean) => {
      const before = await gateway.client.request<{ hash: string }>("config.get", {});
      await gateway.client.request("config.patch", {
        baseHash: before.hash,
        raw: JSON.stringify({
          plugins: {
            entries: {
              "memory-lancedb": { config: { dreaming: { enabled, frequency: "0 0 1 1 *" } } },
            },
          },
        }),
      });
    };
    await toggle(true);
    await expect
      .poll(() => getRuntimeConfig().plugins?.entries?.["memory-lancedb"]?.config?.dreaming, {
        timeout: 20_000,
      })
      .toMatchObject({ enabled: true });
    await expect.poll(async () => (await managedJobs()).length, { timeout: 20_000 }).toBe(1);
    const runningJob = (await managedJobs())[0];
    if (!runningJob) {
      throw new Error("enabled sidecar did not create its declaration");
    }
    runningJobId = runningJob.id;
    const pidPath = path.join(home, "running-command.pid");
    await gateway.client.request("cron.update", {
      id: runningJob.id,
      patch: {
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
        delivery: { mode: "none" },
      },
    });
    const run = await gateway.client.request<{ enqueued: boolean; runId: string }>("cron.run", {
      id: runningJob.id,
      mode: "force",
    });
    expect(run.enqueued).toBe(true);
    let pid = 0;
    await expect
      .poll(
        async () => {
          pid = Number(await fs.readFile(pidPath, "utf8").catch(() => "0"));
          return pid > 0 && isPidAlive(pid);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await toggle(false);
    await expect.poll(async () => (await managedJobs()).length, { timeout: 20_000 }).toBe(0);
    await expect.poll(() => isPidAlive(pid), { timeout: 10_000 }).toBe(false);
    runningJobId = undefined;
    expect(
      getActivePluginRegistry()?.plugins.some(
        (plugin) => plugin.id === "memory-core" && plugin.status === "loaded",
      ),
    ).toBe(false);
    await toggle(true);
    await expect.poll(async () => (await managedJobs()).length, { timeout: 20_000 }).toBe(1);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
    const restartConfig = structuredClone(getRuntimeConfig());
    restartConfig.plugins!.entries!["memory-lancedb"]!.config!.dreaming = { enabled: false };
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "full restart into disabled dreaming" });
    gateway = await start(restartConfig);
    await gateway.server.startupSettled;
    await expect.poll(async () => (await managedJobs()).length, { timeout: 10_000 }).toBe(0);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([authored.id, historical.id]),
    );
  } finally {
    if (runningJobId) {
      await gateway.client.request("cron.remove", { id: runningJobId }).catch(() => undefined);
    }
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "dreaming cleanup proof complete" });
    vi.unstubAllEnvs();
  }
}, 180_000);
