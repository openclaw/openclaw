import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { resolvePluginCapabilityConsent } from "./capability-consent.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { enablePluginWithCapabilityConsent } from "./enable.js";
import { commitConfigWithPendingPluginInstalls } from "./install-record-commit.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(closeOpenClawStateDatabaseForTest);

function pathRecord(id: string) {
  const sourcePath = `/tmp/${id}`;
  return { source: "path" as const, spec: id, sourcePath, installPath: sourcePath };
}

function runChild(scriptPath: string, stateDir: string, id: string) {
  const enteredPath = path.join(stateDir, `${id}-entered`);
  const releasePath = path.join(stateDir, `${id}-release`);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", scriptPath, stateDir, id, enteredPath, releasePath],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  expectDefined(child.stdout, "piped child stdout").on("data", (chunk) => (output += chunk));
  expectDefined(child.stderr, "piped child stderr").on("data", (chunk) => (output += chunk));
  const messageReceived = (expected: string) =>
    new Promise<void>((resolve) => {
      child.on("message", (message) => {
        if (message === expected) {
          resolve();
        }
      });
    });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`install-record commit child exited ${code}: ${output}`));
      }
    });
  });
  const ready = Promise.race([
    messageReceived("ready"),
    done.then(() => {
      throw new Error(`install-record commit child exited before ready: ${output}`);
    }),
  ]);
  return { ready, entered: messageReceived("entered"), done, enteredPath };
}

async function expectFileToStayAbsent(filePath: string, durationMs = 500): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect(fs.statSync(filePath, { throwIfNoEntry: false })).toBeUndefined();
    await delay(10);
  }
}

describe("plugin install record commit rollback", () => {
  it.each([
    { pendingRecords: false, legacy: false },
    { pendingRecords: true, legacy: false },
    { pendingRecords: true, legacy: true },
  ])(
    "preserves consent at config commit (pending: $pendingRecords, legacy: $legacy)",
    async ({ pendingRecords, legacy }) => {
      await withOpenClawTestState({ label: "plugin-consent-commit" }, async (state) => {
        const pluginId = "consent-commit";
        const installPath = state.statePath("extensions", pluginId);
        const writeJson = (name: string, value: unknown) =>
          fs.promises.writeFile(path.join(installPath, name), JSON.stringify(value));
        await fs.promises.mkdir(installPath, { recursive: true });
        await writeJson("package.json", {
          name: "@example/consent-commit",
          openclaw: { extensions: ["./index.cjs"] },
        });
        await fs.promises.writeFile(path.join(installPath, "index.cjs"), "module.exports = {};");
        const manifest = {
          id: pluginId,
          configSchema: { type: "object" },
          contracts: { tools: ["read"] },
        };
        await writeJson("openclaw.plugin.json", manifest);
        const config = { plugins: { entries: { [pluginId]: { enabled: legacy } } } };
        await state.writeConfig(config);
        await withEnvAsync(state.env, async () => {
          const acceptedSurface = resolvePluginArtifactDeclaredSurface(installPath);
          const oldRecord: PluginInstallRecord = { source: "path", installPath };
          if (!legacy) {
            oldRecord.acceptedSurface = acceptedSurface;
            oldRecord.acceptedSurfaceHash = computeDeclaredSurfaceHash(acceptedSurface);
          }
          const withRecord = (source: OpenClawConfig, record: PluginInstallRecord = oldRecord) => ({
            ...source,
            plugins: { ...source.plugins, installs: { [pluginId]: record } },
          });
          await withPluginLifecycleLease({}, (lease) =>
            writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: oldRecord },
              { config, lease },
            ),
          );
          const enabled = await enablePluginWithCapabilityConsent(config, pluginId);
          expect(enabled.enabled).toBe(true);
          const beforeCommit = vi.fn();
          const commit = (sourceConfig: OpenClawConfig) =>
            commitConfigWithPendingPluginInstalls({ sourceConfig, writeOptions: { beforeCommit } });
          if (legacy) {
            await commit(
              withRecord(config, {
                ...oldRecord,
                installedAt: "2026-08-26T00:00:00.000Z",
              }),
            );
            expect(beforeCommit).toHaveBeenCalledTimes(1);
            return;
          }
          await withPluginLifecycleLease({}, async (lease) => {
            await writeJson("openclaw.plugin.json", {
              ...manifest,
              contracts: { tools: ["read", "write"] },
            });
            await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: { source: "path", installPath } },
              { config, lease },
            );
          });
          await expect(
            commit(pendingRecords ? withRecord(enabled.config) : enabled.config),
          ).rejects.toMatchObject({ capabilityConsent: { pluginId } });
          expect(beforeCommit).not.toHaveBeenCalled();
          expect(
            (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords[pluginId]
              ?.acceptedSurface,
          ).toBeUndefined();
          await resolvePluginCapabilityConsent({
            config,
            pluginId,
            acknowledge: {
              reviewToken: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(installPath),
              ),
            },
          });
          await commit(enabled.config);
          expect(beforeCommit).toHaveBeenCalledTimes(1);
        });
      });
    },
  );

  it("serializes two failing direct config commits and restores the original index", async ({
    signal,
    onTestFinished,
  }) => {
    const run = withOpenClawTestState({ label: "plugin-record-failing-commits" }, async (state) => {
      const commitModuleUrl = pathToFileURL(
        path.resolve("src/plugins/install-record-commit.ts"),
      ).href;
      const childScript = await state.writeText(
        "fail-config-commit.mts",
        `
          import fs from "node:fs";
          import { setTimeout as delay } from "node:timers/promises";
          import { commitConfigWithPendingPluginInstalls } from ${JSON.stringify(commitModuleUrl)};
          const [stateDir, pluginId, enteredPath, releasePath] = process.argv.slice(2);
          const record = { source: "path", spec: pluginId, sourcePath: "/tmp/" + pluginId, installPath: "/tmp/" + pluginId };
          process.env.OPENCLAW_STATE_DIR = stateDir;
          process.send?.("ready");
          try {
            await commitConfigWithPendingPluginInstalls({
              nextConfig: { plugins: { installs: { [pluginId]: record } } },
              writeOptions: {
                beforeCommit: async () => {
                  await fs.promises.writeFile(enteredPath, "entered");
                  process.send?.("entered");
                  while (!fs.statSync(releasePath, { throwIfNoEntry: false })) await delay(10);
                  throw new Error("config failed " + pluginId);
                },
              },
            });
            throw new Error("config commit unexpectedly succeeded");
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "config failed " + pluginId) {
              throw error;
            }
          } finally {
            process.disconnect?.();
          }
        `,
      );
      const release = (id: string) =>
        fs.promises.writeFile(state.statePath(`${id}-release`), "release");
      const waitEntered = (child: ReturnType<typeof runChild>) =>
        withinTest(
          awaitGateBeforeSettlement(child.entered, child.done, "waiting for config commit"),
          signal,
        );

      await withEnvAsync(state.env, async () => {
        await withPluginLifecycleLease({}, (lease) =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            { original: pathRecord("original") },
            { config: {}, lease },
          ),
        );

        const first = runChild(childScript, state.stateDir, "first");
        const firstDone = first.done;
        let secondDone: Promise<void> | undefined;
        try {
          // Bootstrap readiness is outside lock assertions; slow TS imports are not blocked writers.
          await withinTest(first.ready, signal);
          await waitEntered(first);
          const second = runChild(childScript, state.stateDir, "second");
          secondDone = second.done;
          await withinTest(second.ready, signal);

          // The second writer cannot enter until the first rolls back.
          await expectFileToStayAbsent(second.enteredPath);

          await release("first");
          await withinTest(firstDone, signal);
          await waitEntered(second);
          await release("second");
          await withinTest(secondDone, signal);
        } finally {
          await Promise.all([release("first"), release("second")]);
          await Promise.allSettled([firstDone, ...(secondDone ? [secondDone] : [])]);
        }
      });

      const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
      expect(persisted?.installRecords).toEqual({ original: pathRecord("original") });
      expect(persisted?.policyHash).toBe(resolveInstalledPluginIndexPolicyHash({}));
    });
    // Cleanup must finish before the next test, including after a timeout.
    onTestFinished(() => run.catch(() => {}));
    await run;
  });
});

it.each([false, true])(
  "returns committed source separately from authored configuration (pending records: %s)",
  async (pending) => {
    await withOpenClawTestState({ label: "committed-plugin-config" }, async (state) => {
      await state.writeConfig({ gateway: { mode: "local" } });
      const nextConfig: OpenClawConfig = { gateway: { mode: "local" } };
      if (pending) {
        nextConfig.plugins = { installs: { fixture: { source: "npm", spec: "fixture@1.0.0" } } };
      }

      const result = await commitConfigWithPendingPluginInstalls({ nextConfig });
      const persisted = JSON.parse(await fs.promises.readFile(state.configPath, "utf8"));

      const { meta: _meta, ...authoredConfig } = persisted;
      expect(authoredConfig).toEqual({ gateway: { mode: "local" } });
      // The committed source resolves the implicit roster without writing it into authored JSON.
      const resolvedSource = { ...persisted, agents: { entries: { main: {} } } };
      expect([result.path, result.movedInstallRecords]).toEqual([state.configPath, pending]);
      expect(result.nextConfig).toEqual(resolvedSource);
      expect(result.persistedSourceConfig).toEqual(resolvedSource);
      expect(result.nextConfig.meta?.lastTouchedVersion).toEqual(expect.any(String));
      expect(result.nextConfig.plugins?.installs).toBeUndefined();
    });
  },
);
