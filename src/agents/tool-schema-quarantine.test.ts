// Tool schema quarantine tests cover diagnostic logging for unreadable runtime
// tool entries without touching the broken tool object again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createEmbeddedRunPermissionChanges,
  withAuthorizedPermissionChange,
} from "./embedded-agent-runner/run/permission-change.js";
import {
  clearRecoveredPersistedRuntimeToolSchemaQuarantines,
  listPersistedRuntimeToolSchemaQuarantines,
  recordPersistedRuntimeToolSchemaQuarantine,
} from "./tool-schema-quarantine-health.js";
import {
  logRuntimeToolSchemaQuarantine,
  withRuntimeToolSchemaQuarantine,
} from "./tool-schema-quarantine.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("runtime tool schema quarantine logging", () => {
  it("does not re-read unreadable tool entries while logging diagnostics", async () => {
    const events: TrustedToolExecutionEvent[] = [];
    const stop = onTrustedToolExecutionEvent((event) => events.push(event));
    const tools = new Proxy([] as AnyAgentTool[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      await expect(
        logRuntimeToolSchemaQuarantine({
          diagnostics: [
            {
              toolName: "tool[0]",
              toolIndex: 0,
              violations: ["tool[0] is unreadable"],
            },
          ],
          tools,
          runId: "run-fuzzplugin-unreadable-tool",
          agentId: "main",
        }),
      ).resolves.toBeUndefined();
    } finally {
      stop();
    }
    expect(events).toMatchObject([
      {
        type: "tool.execution.blocked",
        runId: "run-fuzzplugin-unreadable-tool",
        agentId: "main",
        toolName: "tool[0]",
      },
    ]);
  });

  it("records and clears this process's quarantine without caller-thread SQLite", async () => {
    await withStateDirEnv("openclaw-tool-schema-quarantine-recovery-", async () => {
      const observation = observeHostDataSql();
      try {
        await recordPersistedRuntimeToolSchemaQuarantine({
          toolName: "recovered_tool",
          reason: 'recovered_tool.parameters.type must be "object"',
          failedAt: new Date(123),
        });

        expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([
          {
            toolName: "recovered_tool",
            reason: 'recovered_tool.parameters.type must be "object"',
            failedAt: new Date(123),
          },
        ]);
        await logRuntimeToolSchemaQuarantine({
          diagnostics: [],
          tools: [
            {
              name: "recovered_tool",
              label: "Recovered tool",
              description: "Recovered tool",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
            },
          ],
          runId: "run-recovered-tool",
          agentId: "main",
        });

        expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([]);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
    });
  });
  it("settles recovery submitted while the first record is opening the store", async () => {
    await withStateDirEnv("openclaw-tool-quarantine-opening-", async () => {
      const recording = recordPersistedRuntimeToolSchemaQuarantine({
        toolName: "opening_tool",
        reason: "unsupported schema",
        failedAt: new Date(123),
      });
      const recovering = clearRecoveredPersistedRuntimeToolSchemaQuarantines(() => [
        { toolName: "opening_tool" },
      ]);
      await Promise.all([recording, recovering]);
      expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([]);
    });
  });

  it.each(["before dispatch", "after reply"] as const)(
    "clears an independent recovered key while preserving a renewed failure %s",
    async (phase) => {
      await withStateDirEnv("openclaw-tool-quarantine-overlap-", async () => {
        const quarantine = {
          toolName: "overlapping_tool",
          reason: "unsupported schema",
          failedAt: new Date(123),
        };
        await recordPersistedRuntimeToolSchemaQuarantine(quarantine);
        const healthyQuarantine = { ...quarantine, toolName: "healthy_tool" };
        await recordPersistedRuntimeToolSchemaQuarantine(healthyQuarantine);
        const reached = createDeferredCore();
        const release = createDeferredCore();
        const clear = pluginStateWorker.clearRuntimeHealthInWorker;
        let held = false;
        const observer = vi
          .spyOn(pluginStateWorker, "clearRuntimeHealthInWorker")
          .mockImplementation(async (params) => {
            if (held) {
              return await clear(params);
            }
            held = true;
            if (phase === "after reply") {
              await clear(params);
            }
            reached.resolve();
            await release.promise;
            if (phase === "before dispatch") {
              await clear(params);
            }
          });
        const healthy = () => [quarantine, healthyQuarantine];
        const recovering = clearRecoveredPersistedRuntimeToolSchemaQuarantines(healthy);
        try {
          await reached.promise;
          // Identical persisted fields still belong to a new registration operation.
          await recordPersistedRuntimeToolSchemaQuarantine({ ...quarantine });
          release.resolve();
          await recovering;
          expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([quarantine]);
          await clearRecoveredPersistedRuntimeToolSchemaQuarantines(healthy);
          expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([]);
        } finally {
          release.resolve();
          await recovering;
          observer.mockRestore();
        }
      });
    },
  );

  it.each([false, true])(
    "joins accepted health writes outside synchronous permission authority (throws=%s)",
    async (throws) => {
      await withStateDirEnv("openclaw-tool-quarantine-publication-", async () => {
        const params: Parameters<typeof createEmbeddedRunPermissionChanges>[0] = {
          permissionMode: "read-only",
        };
        const changes = createEmbeddedRunPermissionChanges(params);
        const permission = changes.forAttempt();
        const failure = new Error("projection failed");
        const reached = createDeferredCore();
        const release = createDeferredCore();
        const register = pluginStateWorker.registerPluginStateInWorker;
        const observer = vi
          .spyOn(pluginStateWorker, "registerPluginStateInWorker")
          .mockImplementation(async (input) => {
            try {
              await register(input);
              reached.resolve();
              await release.promise;
            } catch (error) {
              reached.reject(error);
              throw error;
            }
          });
        const pending = withAuthorizedPermissionChange(permission.owner, "full", () =>
          withRuntimeToolSchemaQuarantine((record) => {
            record({
              diagnostics: [
                { toolName: "publication_tool", toolIndex: 0, violations: ["unsupported schema"] },
              ],
              tools: [],
              runId: "run-publication",
              agentId: "main",
            });
            if (throws) {
              throw failure;
            }
            permission.recordApplied("full");
          }),
        );
        let settled = false;
        const observed = pending.then(
          () => {
            settled = true;
            return { ok: true };
          },
          (error: unknown) => {
            settled = true;
            return { ok: false, error };
          },
        );
        try {
          expect(params.permissionMode).toBe(throws ? "read-only" : "full");
          expect(() => permission.recordApplied("full")).toThrow("not authorized");
          await reached.promise;
          expect(settled).toBe(false);
          release.resolve();
          expect(await observed).toEqual(throws ? { ok: false, error: failure } : { ok: true });
          expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([
            {
              toolName: "publication_tool",
              reason: "unsupported schema",
              failedAt: expect.any(Date),
            },
          ]);
        } finally {
          release.resolve();
          await observed;
          observer.mockRestore();
          changes.close();
        }
      });
    },
  );
});
