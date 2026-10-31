import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createTestPluginServiceScheduler } from "../../plugin-sdk/plugin-test-api.js";
import { importFreshModule } from "../../plugin-sdk/test-helpers/import-fresh.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { resolvePluginModuleExport } from "../../plugins/module-export.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import {
  createStandingService,
  installStandingPolicy,
} from "./prepared-pool-standing.test-support.js";
import { usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { requireWorkerProfile } from "./service-validation.js";

const f = usePreparedPoolFixture();
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each([
  { change: "enabled", recovered: false },
  { change: "withdrawn", recovered: false },
  { change: "replaced", recovered: false },
  { change: "profile-changed", recovered: false },
  { change: "target-disabled", recovered: false },
  { change: "enabled", recovered: true },
  { change: "withdrawn", recovered: true },
  { change: "replaced", recovered: true },
  { change: "profile-changed", recovered: true },
  { change: "target-disabled", recovered: true },
])(
  "Crabbox transport: $change standing policy (recovered=$recovered)",
  async ({ change, recovered }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", f.root);
    vi.stubEnv("HOME", f.root);
    const gate = f.gate();
    const commands: string[] = [];
    const allocated = new Set<string>();
    const builder = createTestPluginRegistry(createPluginRuntime());
    let current: ReturnType<typeof createStandingService> | undefined;
    // The real plugin/CLI adapter and subprocess runner are untouched. Only the
    // external CLI is local: it acknowledges commands without any cloud API access.
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      const action = url.pathname.slice(1);
      const id = url.searchParams.get("id")!;
      commands.push(action);
      void (async () => {
        if (
          !["--version", "config", "warmup", "inspect", "run", "heartbeat", "stop"].includes(action)
        ) {
          throw new Error("Unexpected Crabbox transport action: " + action);
        }
        if (action === "inspect" && !allocated.has(id)) {
          response.end(JSON.stringify({ stderr: "aws instance not found: " + id, code: 4 }));
          return;
        }
        if (action === "config") {
          gate.entered.resolve();
          await gate.release.promise;
        }
        if (action === "warmup") {
          allocated.add(id);
        }
        if (action === "stop") {
          allocated.delete(id);
        }
        if (action === "run") {
          const record = f.store
            .list()
            .find((row) => row.nodeSetupId && row.state === "provisioning");
          if (record?.nodeSetupId && !record.nodeDeviceId) {
            const allocation = await f.provider.resolveAllocation(
              requireWorkerProfile(f.developmentProfile.settings ?? {}),
              record.provisionOperationId,
            );
            if (allocation.leaseId !== id) {
              throw new Error("Enrollment reached a different lease");
            }
            await completeWorkerNodeSetupForTest({
              baseDir: f.root,
              store: f.store,
              setupId: record.nodeSetupId,
              deviceId: "node:" + record.provisionOperationId,
              completedAtMs: f.nowMs,
            });
          }
        }
        const stdout =
          action === "--version"
            ? "crabbox 999.0.0"
            : action === "config"
              ? JSON.stringify({ aws: { instanceProfile: "" } })
              : action === "inspect"
                ? JSON.stringify({
                    id,
                    ready: true,
                    state: "running",
                    sshUser: "openclaw",
                    providerMetadata: { instanceProfileAttached: false },
                  })
                : "";
        response.end(JSON.stringify({ stdout, code: 0 }));
      })().catch((error: unknown) => {
        response.end(JSON.stringify({ stderr: String(error), code: 1 }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing transport listener");
    }
    try {
      const script = path.join(f.root, "crabbox.mjs");
      await fs.writeFile(
        script,
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args[0] === "run") for await (const _ of process.stdin) {}',
          'const key = args.includes("--lease-id") ? "--lease-id" : "--id";',
          'const id = args[args.indexOf(key) + 1] ?? "";',
          "const response = await fetch(" +
            JSON.stringify("http://127.0.0.1:" + address.port) +
            ' + "/" + args[0] + "?id=" + encodeURIComponent(id));',
          "const result = await response.json();",
          "if (result.stdout) process.stdout.write(result.stdout);",
          "if (result.stderr) process.stderr.write(result.stderr);",
          "process.exitCode = result.code;",
        ].join("\n"),
        { mode: 0o755 },
      );
      let binary = script;
      if (process.platform === "win32") {
        binary = path.join(f.root, "crabbox.cmd");
        await fs.writeFile(binary, '@"' + process.execPath + '" "' + script + '" %*\r\n');
      }
      const rootDir = fileURLToPath(new URL("../../../extensions/crabbox/", import.meta.url));
      const record = createPluginRecord({
        id: "crabbox",
        source: path.join(rootDir, "index.ts"),
        rootDir,
        origin: "bundled",
        enabled: true,
        configSchema: false,
        contracts: { workerProviders: ["crabbox"] },
      });
      builder.registry.plugins.push(record);
      const { register } = resolvePluginModuleExport(
        await importFreshModule<unknown>(import.meta.url, "../../../extensions/crabbox/index.ts"),
      );
      expectDefined(
        register,
        "Crabbox entry registration",
      )(builder.createApi(record, { config: f.config }));
      f.provider = builder.registry.workerProviders.get("crabbox")!.provider;
      f.developmentProfile.provider = "crabbox";
      f.developmentProfile.settings = {
        binary,
        provider: "aws",
        class: "standard",
        target: "linux",
        ttl: "24h",
        idleTimeout: "60m",
        warmImage: true,
      };
      const policy = installStandingPolicy(f.config, builder);
      const warnings: string[] = [];
      const service = () =>
        createStandingService(f, { logger: { warn: (message) => warnings.push(message) } });
      current = service();
      if (recovered) {
        const intent = await current.prepareProjectIntent("development", {
          imageReserve: true,
          executionMode: "worker-turn",
        });
        await f.store.createIntent({
          ...deriveEnvironmentIntent("transport-recovery"),
          providerId: intent.providerId,
          profileId: "development",
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: intent.profileSnapshot.runtimePreparation!.key,
            demandAtMs: f.nowMs,
            expiresAtMs: f.nowMs + 500,
          },
        });
        await current.stop();
        await f.reopenStore();
        current = service();
      }
      const running = current.setHumanPresence(false);
      f.operations.add(running);
      await awaitGateBeforeSettlement(
        gate.entered.promise,
        running,
        "Real Crabbox config transport was not reached: " + warnings.join("; "),
      );
      if (change === "withdrawn") {
        policy.record.enabled = false;
      }
      if (change === "replaced") {
        await installStandingPolicy(f.config, builder).disposal;
      }
      if (change === "profile-changed") {
        f.developmentProfile.settings = { ...f.developmentProfile.settings, ttl: "48h" };
      }
      if (change === "target-disabled") {
        f.developmentProfile.readyWorkers = 0;
      }
      gate.release.resolve();
      await running;
      const diagnostic = [...warnings, ...f.reserves().map((row) => row.lastError)].join("; ");
      expect(
        commands.filter((action) => action === "warmup"),
        diagnostic,
      ).toHaveLength(change === "enabled" ? 1 : 0);
      expect(
        f.reserves().filter((row) => row.state === "ready"),
        diagnostic,
      ).toHaveLength(change === "enabled" ? 1 : 0);
      expect(policy.credentials).not.toHaveBeenCalled();
    } finally {
      gate.release.resolve();
      await Promise.allSettled(f.operations);
      await current?.stop();
      const scheduler = createTestPluginServiceScheduler();
      scheduler.beginClose();
      for (const entry of builder.registry.services) {
        if (entry.service.stop) {
          await entry.service.stop({
            config: f.config,
            stateDir: f.root,
            logger: console,
            scheduler,
          });
        }
      }
      await scheduler.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
