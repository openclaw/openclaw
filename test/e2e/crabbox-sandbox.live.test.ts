// Opt in with OPENCLAW_E2E_CRABBOX=1 and an authenticated fixed-ID provider.
// OPENCLAW_E2E_CRABBOX_{PROVIDER,CLASS,BINARY} select the Crabbox installation.
// OPENCLAW_E2E_CRABBOX_ARTIFACT_DIR must be outside runner-owned temporary storage.
// Set OPENCLAW_E2E_CRABBOX_TOKEN_WAIT_MS above the provider's SSH token lifetime
// to prove a retained handle refreshes access without reseeding remote edits.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  OpenClawPluginService,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "../../extensions/crabbox/index.js";
import { runExecProcess } from "../../src/agents/bash-tools.exec-runtime.js";
import { resolveSandboxContext } from "../../src/agents/sandbox/context.js";
import { listSandboxContainers, removeSandboxContainer } from "../../src/agents/sandbox/manage.js";
import { readRegistry } from "../../src/agents/sandbox/registry.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { closeOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";

const LIVE = process.env.OPENCLAW_E2E_CRABBOX === "1";
const LIVE_TIMEOUT_MS = 20 * 60_000;

describe.skipIf(!LIVE)("Crabbox registered sandbox backend (live)", () => {
  it(
    "shares a durable lease, preserves remote edits across reopen, and recreates through management",
    async () => {
      const artifactDir = process.env.OPENCLAW_E2E_CRABBOX_ARTIFACT_DIR;
      if (!artifactDir) {
        throw new Error(
          "Set OPENCLAW_E2E_CRABBOX_ARTIFACT_DIR outside the test runner's temporary directory so failed cleanup remains recoverable.",
        );
      }
      await fs.mkdir(artifactDir, { recursive: true });
      const root = await fs.mkdtemp(path.join(artifactDir, "openclaw-crabbox-e2e-"));
      const stateDir = path.join(root, "state");
      const homeDir = path.join(root, "home");
      await fs.mkdir(homeDir, { recursive: true });
      console.log(`Crabbox live: state root ${root}`);
      const workspaceDir = path.join(root, "workspace");
      const configPath = path.join(root, "openclaw.json");
      const tokenWaitMs = Number(process.env.OPENCLAW_E2E_CRABBOX_TOKEN_WAIT_MS ?? 0);
      expect(Number.isSafeInteger(tokenWaitMs) && tokenWaitMs >= 0).toBe(true);
      const sandbox = {
        provider: process.env.OPENCLAW_E2E_CRABBOX_PROVIDER,
        class: process.env.OPENCLAW_E2E_CRABBOX_CLASS,
        binary: process.env.OPENCLAW_E2E_CRABBOX_BINARY,
        ttl: "30m",
        idleTimeout: "15m",
      };
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            sandbox: {
              mode: "all",
              backend: "crabbox",
              scope: "shared",
              workspaceAccess: "rw",
              workspaceRoot: path.join(root, "sandboxes"),
              browser: { enabled: false },
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
        plugins: { entries: { crabbox: { enabled: true, config: { sandbox } } } },
      };
      await fs.mkdir(workspaceDir, { recursive: true });
      await promisify(execFile)("git", ["init", "--quiet", workspaceDir]);
      await fs.writeFile(path.join(workspaceDir, "marker.txt"), "seeded-marker\n");
      await fs.writeFile(configPath, JSON.stringify(config));
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("XDG_STATE_HOME", path.join(homeDir, ".local", "state"));
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      setRuntimeConfigSnapshot(config);

      function registerGeneration(binary = sandbox.binary) {
        const lifecycle: PluginRuntimeLifecycleRegistration[] = [];
        const services: OpenClawPluginService[] = [];
        const api = createTestPluginApi({
          id: "crabbox",
          config,
          pluginConfig: { sandbox: { ...sandbox, binary } },
          rootDir: fileURLToPath(new URL("../../extensions/crabbox/", import.meta.url)),
          registerRuntimeLifecycle: (registration) => lifecycle.push(registration),
          registerService: (service) => services.push(service),
        });
        plugin.register(api);
        return async () => {
          for (const registration of lifecycle) {
            await registration.cleanup?.({ reason: "restart" });
          }
          for (const service of services) {
            await service.stop?.({ config, stateDir, workspaceDir, logger: api.logger });
          }
        };
      }

      async function resolve(session: string, callerWorkspaceDir = workspaceDir) {
        const context = await resolveSandboxContext({
          config,
          sessionKey: `agent:main:crabbox-e2e:${session}`,
          workspaceDir: callerWorkspaceDir,
        });
        if (!context?.backend || !context.fsBridge) {
          throw new Error("The registered Crabbox backend did not provide exec and file tools.");
        }
        return { ...context, backend: context.backend, fsBridge: context.fsBridge };
      }

      let stopGeneration = registerGeneration(path.join(root, "missing-crabbox"));
      let leasesReleased = false;
      let transferredLease: { id: string; workspaceDir: string } | undefined;
      const errors: unknown[] = [];
      async function crabbox(args: string[], cwd: string): Promise<string> {
        try {
          const result = await promisify(execFile)(sandbox.binary ?? "crabbox", args, {
            cwd,
            timeout: 10 * 60_000,
            maxBuffer: 1024 * 1024,
          });
          return result.stdout;
        } catch {
          // Provider diagnostics can contain credentials; retain only the action.
          throw new Error(`Live Crabbox ${args[0]} failed`);
        }
      }
      try {
        await expect(resolve("before-config-repair")).rejects.toThrow(
          /requires a build with claim-owned/,
        );
        const pending = (await readRegistry()).entries[0];
        expect(pending?.runtimeState).toBe("pending");
        if (!pending) {
          throw new Error("Failed provisioning did not retain a reservation.");
        }
        await stopGeneration();
        stopGeneration = registerGeneration();
        await removeSandboxContainer(pending.containerName);
        expect((await readRegistry()).entries).toEqual([]);
        console.log(`Crabbox live: recovered pre-submission reservation ${pending.containerName}`);

        // Settle both creators before cleanup even if one provisioning attempt fails.
        const creations = await Promise.allSettled([resolve("first"), resolve("second")]);
        const contexts = creations.map((creation) => {
          if (creation.status === "rejected") {
            throw creation.reason;
          }
          return creation.value;
        });
        const first = contexts[0]!;
        expect(contexts[1]!.runtimeId).toBe(first.runtimeId);
        expect((await readRegistry()).entries).toHaveLength(1);
        const otherWorkspaceDir = path.join(root, "other-workspace");
        await fs.mkdir(otherWorkspaceDir);
        await promisify(execFile)("git", ["init", "--quiet", otherWorkspaceDir]);
        const shared = await resolve("other-workspace", otherWorkspaceDir);
        expect(shared.runtimeId).toBe(first.runtimeId);
        expect(shared.workspaceDir).toBe(otherWorkspaceDir);
        console.log(`Crabbox live: concurrent creators share ${first.runtimeId}`);

        const execution = await runExecProcess({
          command: "cat marker.txt && uname -s",
          workdir: workspaceDir,
          env: {},
          sandbox: {
            ...first.backend,
            containerName: first.runtimeId,
            workspaceDir,
            containerWorkdir: first.containerWorkdir,
          },
          usePty: false,
          warnings: [],
          maxOutput: 10_000,
          pendingMaxOutput: 10_000,
          notifyOnExit: false,
          timeoutSec: 60,
        });
        const seeded = await execution.promise;
        expect(seeded.exitCode).toBe(0);
        expect(seeded.aggregated.trim()).toBe("seeded-marker\nLinux");
        const remoteFile = { filePath: "remote-only.txt", cwd: first.containerWorkdir };
        await first.fsBridge.writeFile({ ...remoteFile, data: "retained-remote-edit\n" });
        expect((await first.fsBridge.readFile(remoteFile)).toString("utf8")).toBe(
          "retained-remote-edit\n",
        );
        await expect(fs.access(path.join(workspaceDir, "remote-only.txt"))).rejects.toThrow();
        await fs.writeFile(path.join(workspaceDir, "marker.txt"), "changed-host-marker\n");
        if (tokenWaitMs > 0) {
          console.log(`Crabbox live: waiting ${tokenWaitMs} ms before retained-handle access`);
          await delay(tokenWaitMs);
          expect((await first.fsBridge.readFile(remoteFile)).toString("utf8")).toBe(
            "retained-remote-edit\n",
          );
        }

        // Reopen the real database and plugin registration, not a simulated process restart.
        await stopGeneration();
        closeOpenClawStateDatabase();
        stopGeneration = registerGeneration();
        const adopted = await resolve("after-reopen");
        expect(adopted.runtimeId).toBe(first.runtimeId);
        expect((await adopted.fsBridge.readFile(remoteFile)).toString("utf8")).toBe(
          "retained-remote-edit\n",
        );
        expect(
          (await adopted.fsBridge.readFile({ ...remoteFile, filePath: "marker.txt" })).toString(
            "utf8",
          ),
        ).toBe("seeded-marker\n");
        expect(await listSandboxContainers()).toMatchObject([
          { containerName: first.runtimeId, running: true },
        ]);

        await removeSandboxContainer(first.runtimeId);
        await expect(first.backend.runShellCommand({ script: "true" })).rejects.toThrow(/removed/);
        expect((await readRegistry()).entries).toEqual([]);
        const recreated = await resolve("after-recreate");
        expect(recreated.runtimeId).not.toBe(first.runtimeId);
        expect(
          (await recreated.fsBridge.readFile({ filePath: "marker.txt" })).toString("utf8"),
        ).toBe("changed-host-marker\n");
        console.log(`Crabbox live: adopted ${first.runtimeId}; recreated ${recreated.runtimeId}`);

        const admitted = await runExecProcess({
          command: "true",
          workdir: workspaceDir,
          env: {},
          sandbox: {
            ...recreated.backend,
            containerName: recreated.runtimeId,
            workspaceDir,
            containerWorkdir: recreated.containerWorkdir,
          },
          usePty: false,
          warnings: [],
          maxOutput: 10_000,
          pendingMaxOutput: 10_000,
          notifyOnExit: false,
          timeoutSec: 60,
          beforeSpawn: async () => {
            await crabbox(
              [
                "warmup",
                ...(sandbox.provider ? ["--provider", sandbox.provider] : []),
                ...(sandbox.class ? ["--class", sandbox.class] : []),
                "--lease-id",
                recreated.runtimeId,
                "--slug",
                "openclaw-sandbox",
                "--keep",
                "--ttl",
                sandbox.ttl,
                "--idle-timeout",
                sandbox.idleTimeout,
                "--reclaim",
              ],
              otherWorkspaceDir,
            );
            transferredLease = { id: recreated.runtimeId, workspaceDir: otherWorkspaceDir };
            return undefined;
          },
        });
        const denied = await admitted.promise;
        expect(denied.exitCode).not.toBe(0);
        expect(denied.aggregated).toMatch(/repository|owned|claim/i);
        await expect(recreated.fsBridge.readFile({ filePath: "marker.txt" })).rejects.toThrow();
        await expect(removeSandboxContainer(recreated.runtimeId)).rejects.toThrow();
        expect((await readRegistry()).entries).toHaveLength(1);
        expect(
          await crabbox(
            ["exec", "--id", recreated.runtimeId, "--", "/bin/sh", "-c", "printf current-owner"],
            otherWorkspaceDir,
          ),
        ).toBe("current-owner");
        await crabbox(["stop", "--current-repo", "--id", recreated.runtimeId], otherWorkspaceDir);
        transferredLease = undefined;
        await removeSandboxContainer(recreated.runtimeId);
        expect((await readRegistry()).entries).toEqual([]);
        console.log(
          "Crabbox live: prepared exec, file access, and cleanup respect repository transfer; current owner succeeds",
        );
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          if (transferredLease) {
            await crabbox(
              ["stop", "--current-repo", "--id", transferredLease.id],
              transferredLease.workspaceDir,
            );
          }
          const cleanup = await Promise.allSettled(
            (await readRegistry()).entries.map((entry) =>
              removeSandboxContainer(entry.containerName),
            ),
          );
          const failures = cleanup.filter((result) => result.status === "rejected");
          if (failures.length) {
            errors.push(...failures.map((result) => result.reason));
          }
          leasesReleased = failures.length === 0;
          if (leasesReleased) {
            console.log("Crabbox live: all registered leases released");
          }
        } catch (error) {
          errors.push(error);
        } finally {
          await stopGeneration();
          closeOpenClawStateDatabase();
          clearRuntimeConfigSnapshot();
          vi.unstubAllEnvs();
          if (leasesReleased) {
            await fs.rm(root, { recursive: true, force: true });
          } else {
            console.log(`Crabbox live: recovery state retained at ${root}`);
          }
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Crabbox live scenario or cleanup failed");
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
