import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as records from "../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import * as update from "../plugins/update.js";
import { createNonExitingRuntime } from "../runtime.js";
import * as worker from "../state/openclaw-state-lease-worker-operation.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareAutomaticSetupCodex, stageCodexCandidate } from "./setup-inference-codex.js";
import {
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import { pluginRecord } from "./verified-inference.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("binds automatic Codex path trust to the selected bundle", async () => {
  await withOpenClawTestState(
    {
      label: "codex-bundled-path-trust",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      },
    },
    async (state) => {
      const rootDir = state.statePath("bundled", "codex");
      const cfg: OpenClawConfig = {};
      await state.writeConfig(cfg);
      const snapshot = await readConfigFileSnapshot();
      const metadata = createEmptyPluginMetadataSnapshot(state.workspaceDir);
      for (const { sourceMatches, installMatches, origin, accepted } of [
        { sourceMatches: true, installMatches: true, origin: "bundled", accepted: true },
        { sourceMatches: false, installMatches: true, origin: "bundled", accepted: false },
        { sourceMatches: true, installMatches: false, origin: "bundled", accepted: false },
        { sourceMatches: true, installMatches: true, origin: "config", accepted: false },
      ] as const) {
        const staged = await stageCodexCandidate(
          {
            cfg,
            snapshot,
            workspace: state.workspaceDir,
            agentDir: state.agentDir(),
            routeAgentId: "main",
            params: {
              kind: "codex-cli",
              automaticSetup: true,
              surface: "gateway",
              runtime: createNonExitingRuntime(),
            },
            deps: {
              resolvePluginMetadataSnapshot: () => ({
                ...metadata,
                index: {
                  ...metadata.index,
                  plugins: [pluginRecord("codex", { origin, rootDir })],
                  installRecords: {
                    codex: {
                      source: "path",
                      sourcePath: sourceMatches ? rootDir : state.statePath("foreign", "codex"),
                      installPath: installMatches ? rootDir : state.statePath("foreign", "codex"),
                    },
                  },
                },
              }),
              ensureCodexRuntimePlugin: async ({ cfg: config }) => ({
                ok: true,
                cfg: config,
                required: false,
              }),
            },
            effects: { credentialsSaved: false },
            beforePersistentEffect: async () => {},
          },
          "openai/fixture",
        );
        if (accepted) {
          expect(staged).toMatchObject({
            agentRuntimeId: "codex",
            config: {
              plugins: { entries: { codex: { config: { appServer: { homeScope: "user" } } } } },
            },
          });
        } else {
          expect(staged).toMatchObject({ error: expect.stringContaining("official Codex plugin") });
        }
      }
    },
  );
});

it.each([
  { candidate: false, revoke: false },
  { candidate: false, revoke: true },
  { candidate: true, revoke: false },
  { candidate: true, revoke: true },
])(
  "fences Codex repair publication (candidate=$candidate, revoked=$revoke)",
  async ({ candidate, revoke }) => {
    await withOpenClawTestState(
      {
        label: "codex-repair-authority",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.10.2",
        },
      },
      async (state) => {
        const installPath = state.statePath("npm", "node_modules", "@openclaw", "codex");
        await fs.mkdir(installPath, { recursive: true });
        await fs.writeFile(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@openclaw/codex",
            version: "2026.10.2",
            dependencies: { "@fixture/missing-dependency": "1.0.0" },
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        await fs.writeFile(path.join(installPath, "index.js"), "export {};");
        await fs.writeFile(
          path.join(installPath, "openclaw.plugin.json"),
          JSON.stringify({ id: "codex", configSchema: { type: "object" } }),
        );
        const cfg: OpenClawConfig = {
          agents: { defaults: { models: { "openai/fixture": { agentRuntime: { id: "codex" } } } } },
          plugins: { entries: { codex: { enabled: true } } },
        };
        await state.writeConfig(cfg);
        await withPluginLifecycleLease({}, async (lease) => {
          await records.writePersistedInstalledPluginIndexInstallRecordsWithLease(
            {
              codex: {
                source: "npm",
                spec: "@openclaw/codex@2026.10.2",
                resolvedName: "@openclaw/codex",
                resolvedVersion: "2026.10.2",
                integrity: "sha512-before-repair",
                installPath,
              },
            },
            { config: cfg, lease },
          );
        });
        let repaired = false;
        // Package acquisition is synthetic; Doctor, leases and SQLite publication stay real.
        vi.spyOn(update, "updateNpmInstalledPlugins").mockImplementation(async (params) => {
          repaired = true;
          return {
            config: {
              ...params.config,
              plugins: {
                ...params.config.plugins,
                installs: {
                  ...params.config.plugins?.installs,
                  codex: {
                    ...params.config.plugins?.installs?.codex,
                    source: "npm",
                    spec: "@openclaw/codex@2026.10.2",
                    resolvedName: "@openclaw/codex",
                    resolvedVersion: "2026.10.2",
                    integrity: "sha512-after-repair",
                    installPath,
                  },
                },
              },
            },
            outcomes: [{ pluginId: "codex", status: "updated", message: "Repaired fixture" }],
            changed: true,
          };
        });
        const entered = createDeferred();
        const release = createDeferred();
        const runWorker = worker.runWithOpenClawStateLeaseWorker;
        vi.spyOn(worker, "runWithOpenClawStateLeaseWorker").mockImplementation(async (...args) => {
          if (repaired) {
            repaired = false;
            entered.resolve();
            await release.promise;
          }
          return await runWorker(...args);
        });
        let revoked = false;
        const isCancelled = () => revoked;
        const beforePersistentApply = () => throwIfSetupInferenceCancelled({ isCancelled });
        const beforePersistentEffect = async () => {};
        const runtime = createNonExitingRuntime();
        const snapshot = await readConfigFileSnapshot();
        const preparing = candidate
          ? stageCodexCandidate(
              {
                cfg,
                snapshot,
                workspace: state.workspaceDir,
                agentDir: state.agentDir(),
                routeAgentId: "main",
                params: {
                  kind: "codex-cli",
                  automaticSetup: true,
                  surface: "gateway",
                  runtime,
                  isCancelled,
                },
                deps: {},
                effects: { credentialsSaved: false },
                beforePersistentEffect,
              },
              "openai/fixture",
            )
          : prepareAutomaticSetupCodex({
              cfg,
              runtime,
              workspace: state.workspaceDir,
              beforePersistentEffect,
              beforePersistentApply,
            });
        const checked = preparing.then((value) => {
          if ("error" in value) {
            throw new Error(value.error);
          }
          return value;
        });
        const settled = checked.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            checked,
            "repair never reached index preparation",
          );
          revoked = revoke;
          release.resolve();
          const outcome = await settled;
          const persisted = await records.readPersistedInstalledPluginIndexInstallRecordsAsync();
          expect(persisted?.codex?.integrity).toBe(
            revoke ? "sha512-before-repair" : "sha512-after-repair",
          );
          if (revoke) {
            expect(outcome).toMatchObject({
              ok: false,
              error: expect.any(SetupInferenceCancelledError),
            });
          } else {
            expect(outcome).toMatchObject({ ok: true });
            if (outcome.ok) {
              expect(outcome.value).not.toHaveProperty("error");
            }
          }
        } finally {
          release.resolve();
          await settled;
        }
      },
    );
  },
);
