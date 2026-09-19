import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crabboxPlugin from "../../extensions/crabbox/index.js";
import { ensureSessionEntrySync } from "../../src/config/sessions/session-accessor.js";
import * as support from "../../src/gateway/worker-environments/service.test-support.js";
import type { OpenAsyncKeyedStoreOptions } from "../../src/plugin-sdk/plugin-state-runtime.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../../src/plugin-sdk/plugin-state-test-runtime.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import * as processRuntime from "../../src/plugin-sdk/process-runtime.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { OpenClawPluginService, WorkerProvider } from "../../src/plugins/types.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../../src/state/openclaw-agent-db.js";

describe("Crabbox allocation through Gateway ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();
  const identity = {
    sessionId: "crabbox-authority",
    sessionKey: "agent:main:crabbox-authority",
    agentId: "main",
  };
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    support.testState.config.session = {
      store: path.join(support.testState.root, "sessions.json"),
    };
    ensureSessionEntrySync(
      { ...identity, storePath: support.testState.config.session.store },
      { sessionId: identity.sessionId, updatedAt: 1 },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabases();
    resetPluginStateStoreForTests();
  });

  it.each([
    { allocation: "warmup", allowed: true },
    { allocation: "warmup", allowed: false },
    { allocation: "fork", allowed: true },
    { allocation: "fork", allowed: false },
  ] as const)(
    "carries live authority through deferred $allocation selection: allowed=$allowed",
    async ({ allocation, allowed }) => {
      const entered = createDeferredCore();
      const released = createDeferredCore();
      let pauseLookup = false;
      const runtime = createPluginRuntimeMock({
        state: {
          openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
            const store = createPluginStateKeyedStoreForTests<T>("crabbox", {
              ...options,
              env: { OPENCLAW_STATE_DIR: support.testState.root },
            });
            return {
              ...store,
              entries: async () => {
                const entries = await store.entries();
                if (options.namespace === "warm-images" && pauseLookup) {
                  pauseLookup = false;
                  entered.resolve();
                  await released.promise;
                }
                return entries;
              },
            };
          },
        },
      });
      const leases = new Set<string>();
      const result = (stdout = "", code = 0): processRuntime.SpawnResult => ({
        stdout,
        stderr: "",
        code,
        signal: null,
        killed: false,
        termination: "exit",
      });
      const runner = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          const value = (flag: string) => argv[argv.indexOf(flag) + 1]!;
          if (argv[1] === "--version") {
            return result("crabbox 0.56.0\n");
          }
          if (argv[1] === "config") {
            return result(JSON.stringify({ aws: { instanceProfile: "" } }));
          }
          if (argv[1] === "warmup") {
            leases.add(value("--lease-id"));
          }
          if (argv[1] === "checkpoint" && argv[2] === "fork") {
            leases.add(value("--lease-id"));
            return result(
              JSON.stringify({
                checkpointId: argv[3],
                leaseId: value("--lease-id"),
                slug: value("--slug"),
                provider: "aws",
                workdir: "/workspace",
              }),
            );
          }
          if (argv[1] === "checkpoint" && argv[2] === "create") {
            return result(
              JSON.stringify({
                id: "chk_authority",
                kind: "aws-ebs-snapshot",
                leaseId: value("--id"),
                workdir: "/workspace",
                native: { imageId: "snap_authority", state: "completed" },
              }),
            );
          }
          if (argv[1] === "checkpoint" && argv[2] === "inspect") {
            return result(
              JSON.stringify({
                localState: "metadata_available",
                providerState: "available",
                nextAction: "fork_or_delete",
              }),
            );
          }
          if (argv[1] === "inspect" || argv[1] === "status") {
            const id = value("--id");
            return leases.has(id)
              ? result(
                  JSON.stringify({
                    id,
                    state: "running",
                    ready: true,
                    providerMetadata: { instanceProfileAttached: false },
                  }),
                )
              : { ...result("", 4), stderr: `lease/server not found: ${id}` };
          }
          if (argv[1] === "stop") {
            leases.delete(value("--id"));
          }
          return result();
        });
      const providers: WorkerProvider[] = [];
      const services: OpenClawPluginService[] = [];
      const api = createTestPluginApi({
        id: "crabbox",
        runtime,
        rootDir: fileURLToPath(new URL("../../extensions/crabbox/", import.meta.url)),
        registerWorkerProvider: (provider) => providers.push(provider),
        registerService: (service) => services.push(service),
      });
      crabboxPlugin.register(api);
      const provider = providers[0]!;
      const settings = {
        binary: process.execPath,
        provider: "aws",
        class: "standard",
        ttl: "24h",
        idleTimeout: "60m",
        warmImage: allocation === "fork",
      };
      support.testState.config.cloudWorkers!.profiles!.development = {
        provider: "crabbox",
        settings,
      };
      const service = support.createService(provider, {
        prepareNodeEnrollment: async () => ({
          mode: "connect",
          setupCode: "synthetic-setup",
          setupId: "setup-authority",
          openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
          displayName: "Synthetic worker",
          nodeBootstrap: support.NODE_BOOTSTRAP,
          waitForDeviceId: async () => "node-authority",
        }),
        ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
      });
      try {
        if (allocation === "fork") {
          const seed = await service.create("development", "checkpoint-source");
          await service.destroyUnattached(seed.environmentId);
        }
        runner.mockClear();
        pauseLookup = true;
        let current = true;
        const signal = new AbortController().signal;
        const creation = service
          .createSessionAttachment(
            { ...identity, profileId: "development", idempotencyKey: "final-allocation" },
            () => {
              if (!current) {
                throw new Error("Caller allocation authority revoked");
              }
            },
            signal,
          )
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        await Promise.race([
          entered.promise,
          creation.then((outcome) => {
            throw new Error(
              `Provision ended before lease lookup: ${"error" in outcome ? String(outcome.error) : "completed"}`,
            );
          }),
        ]);
        current = allowed;
        released.resolve();
        const outcome = await creation;
        expect(signal.aborted).toBe(false);
        expect("error" in outcome).toBe(!allowed);
        const effects = () =>
          runner.mock.calls.filter(
            ([argv]) => argv[1] === "warmup" || (argv[1] === "checkpoint" && argv[2] === "fork"),
          );
        expect(effects()).toHaveLength(allowed ? 1 : 0);
        if (allowed) {
          expect(effects()[0]![0][allocation === "fork" ? 2 : 1]).toBe(allocation);
        }
        const attached = service.getSessionAttachmentStatus(identity.sessionId)!;
        if (!allowed) {
          expect(attached.attachment.closedAtMs).not.toBeNull();
        }
        await service.reconcileOnce(attached.attachment.environmentId);
        expect(effects()).toHaveLength(allowed ? 1 : 0);
        if (allowed) {
          await service.destroySessionAttachment({ sessionId: identity.sessionId }, () => {});
        }
      } finally {
        released.resolve();
        await service.stop();
        for (const owner of services) {
          await owner.stop?.({
            config: support.testState.config,
            stateDir: support.testState.root,
            logger: api.logger,
          });
        }
      }
    },
  );
});
