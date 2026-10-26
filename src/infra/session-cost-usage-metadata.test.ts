import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshotState } from "../plugins/current-plugin-metadata-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotAsync as resolveSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { loadSessionLogs } from "./session-cost-usage.js";

const tempDirs = useStateDatabaseTempDirs();
beforeEach(clearPluginMetadataLifecycleCaches);
afterEach(async () => {
  vi.unstubAllEnvs();
  clearPluginMetadataLifecycleCaches();
});

it("keeps an async forced fresh inventory outside the adopted process snapshot", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-async-usage-metadata-") };
  const config = { plugins: { enabled: false } };
  const first = await resolveSnapshot({ config, env });
  expect(await resolveSnapshot({ config, env, index: first.index, allowCurrent: false })).not.toBe(
    first,
  );
  expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(first);
});

it.each(["database admission", "plugin cache"] as const)(
  "retains every log record or rejects when pricing loses its %s",
  async (owner) => {
    const sessionFile = path.join(tempDirs.make("usage-log-cancellation-"), "transcript.jsonl");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(sessionFile));
    const logRecord = (message: Record<string, unknown>) =>
      JSON.stringify({ message: { role: "assistant", ...message } });
    await fs.writeFile(
      sessionFile,
      [
        "malformed JSON",
        logRecord({ content: [null] }),
        logRecord({
          content: "Billed",
          timestamp: 1,
          usage: { input: 10, cost: { total: 0, totalOrigin: "provider-billed" } },
        }),
        logRecord({
          content: "Estimated",
          timestamp: 2,
          provider: "fixture",
          model: "priced",
          usage: { input: 100, output: 20 },
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
    const model: ModelDefinitionConfig = {
      id: "priced",
      name: "Fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    };
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          fixture: { baseUrl: "https://fixture.invalid", models: [model] },
        },
      },
    };
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
    const outcome = Promise.allSettled([request]).then(([result]) => result);
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
        await expect(request).rejects.toMatchObject({
          code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
        });
      } else {
        await expect(request).resolves.toEqual(expectedLogs);
      }
    } finally {
      reading.resolve();
      await outcome;
      await retirement;
    }
    await using resumed = createPluginCache();
    expect(await withPluginCache(resumed, () => loadSessionLogs(params))).toEqual(expectedLogs);
  },
);
