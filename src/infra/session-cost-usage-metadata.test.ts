import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "../plugins/current-plugin-metadata-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshotAsync,
} from "../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { loadSessionLogs } from "./session-cost-usage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps async cold adoption, workspace scopes, and forced fresh inventories distinct", async () => {
  const stateDir = tempDirs.make("openclaw-async-usage-metadata-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const config = { plugins: { enabled: false } };
  clearPluginMetadataLifecycleCaches();
  try {
    const first = await resolvePluginMetadataSnapshotAsync({ config, env });
    expect(await resolvePluginMetadataSnapshotAsync({ config: structuredClone(config), env })).toBe(
      first,
    );
    const workspaceDir = path.join(stateDir, "workspace");
    const scoped = withPluginCache(createPluginCache(), () =>
      loadPluginMetadataSnapshot({ config, env, index: first.index, workspaceDir }),
    );
    await withPluginMetadataSnapshotScope(
      scoped,
      async () => {
        expect(
          await resolvePluginMetadataSnapshotAsync({
            config,
            env,
            allowWorkspaceScopedCurrent: true,
          }),
        ).toBe(scoped);
        const empty = await resolvePluginMetadataSnapshotAsync({
          config,
          env,
          pluginIds: [],
          allowWorkspaceScopedCurrent: true,
        });
        expect(empty.plugins).toEqual([]);
        expect(empty.index).toBe(scoped.index);
      },
      { config, env, workspaceDir, trustConfigIdentity: true },
    );
    const fresh = await resolvePluginMetadataSnapshotAsync({
      config,
      env,
      index: first.index,
      allowCurrent: false,
    });
    expect(fresh).not.toBe(first);
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(first);
  } finally {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
  }
});

it.each(["database admission", "plugin cache"] as const)(
  "retains every log record or rejects when pricing loses its %s",
  async (owner) => {
    const stateDir = tempDirs.make("openclaw-pricing-log-cancellation-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    clearPluginMetadataLifecycleCaches();
    const sessionFile = path.join(stateDir, "transcript.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        "malformed JSON",
        JSON.stringify({ message: { role: "assistant", content: [null] } }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "Billed",
            timestamp: 1,
            usage: { input: 10, cost: { total: 0, totalOrigin: "provider-billed" } },
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "Estimated",
            timestamp: 2,
            provider: "fixture",
            model: "priced",
            usage: { input: 100, output: 20 },
          },
        }),
      ].join("\n"),
    );
    const started = createDeferredCore();
    const reading = createDeferredCore();
    const executeRead = stateReads.executeExistingOpenClawStateRead;
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
      async (options, command, readOptions) => {
        const context = readOptions?.context ?? captureOpenClawStateReadWorkerContext(options);
        started.resolve();
        await reading.promise;
        return executeRead(options, command, { ...readOptions, context });
      },
    );
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid",
            models: [
              {
                id: "priced",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };
    try {
      await using cache = createPluginCache();
      const params = { agentId: "main", sessionFile, config };
      const expectedLogs = [
        { timestamp: 1, role: "assistant", content: "Billed", tokens: 10, cost: 0 },
        {
          timestamp: 2,
          role: "assistant",
          content: "Estimated",
          tokens: 120,
          cost: expect.closeTo(0.00026, 12),
        },
      ];
      const request = withPluginCache(cache, () => loadSessionLogs(params));
      const outcome = request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      let retirement: ReturnType<typeof retirePluginCache> | undefined;
      try {
        const first = await Promise.race([started.promise.then(() => "reading" as const), outcome]);
        expect(first).toBe("reading");
        retirement = owner === "plugin cache" ? retirePluginCache(cache) : undefined;
        if (owner === "database admission") {
          await closeOpenClawStateDatabaseAsync();
        }
        reading.resolve();
        if (owner === "database admission") {
          expect(await outcome).toMatchObject({
            status: "rejected",
            error: {
              code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
            },
          });
        } else {
          expect(await outcome).toEqual({ status: "fulfilled", value: expectedLogs });
        }
      } finally {
        reading.resolve();
        await outcome;
        await retirement;
      }
      await using resumed = createPluginCache();
      expect(await withPluginCache(resumed, () => loadSessionLogs(params))).toEqual(expectedLogs);
    } finally {
      reading.resolve();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      clearPluginMetadataLifecycleCaches();
      await closeOpenClawStateDatabaseAsync();
    }
  },
);
