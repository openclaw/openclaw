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
  createEmbeddedRunPermissionChanges as createChanges,
  withAuthorizedPermissionChange as withPermission,
} from "./embedded-agent-runner/run/permission-change.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  listPersistedRuntimeToolSchemaQuarantines as listQuarantines,
  recordPersistedRuntimeToolSchemaQuarantine as recordQuarantine,
} from "./tool-schema-quarantine-health.js";
import {
  logRuntimeToolSchemaQuarantine as logQuarantine,
  withRuntimeToolSchemaQuarantine,
} from "./tool-schema-quarantine.js";
import type { AnyAgentTool } from "./tools/common.js";

const quarantine = (toolName: string) => ({
  toolName,
  reason: "unsupported schema",
  failedAt: new Date(123),
});
const logParams = (toolName: string, tools: AnyAgentTool[] = [], violations: string[] = []) => ({
  runId: "run",
  agentId: "main",
  tools,
  diagnostics: violations.length ? [{ toolName, toolIndex: 0, violations }] : [],
});

afterEach(() => resetPluginStateStoreForTests());

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
      await logQuarantine(logParams("tool[0]", tools, ["tool[0] is unreadable"]));
    } finally {
      stop();
    }
    expect(events).toMatchObject([
      { type: "tool.execution.blocked", runId: "run", agentId: "main", toolName: "tool[0]" },
    ]);
  });

  it("logs recovery during store opening without caller-thread SQLite", async () => {
    await withStateDirEnv("openclaw-tool-quarantine-opening-", async () => {
      const observation = observeHostDataSql();
      try {
        const recording = recordQuarantine(quarantine("tool"));
        const recovering = logQuarantine(logParams("tool", [createStubTool("tool")]));
        await Promise.all([recording, recovering]);
        expect(await listQuarantines()).toEqual([]);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
    });
  });

  it.each([false, true])("joins health writes outside authority (%s)", async (throws) => {
    await withStateDirEnv("openclaw-tool-quarantine-publication-", async () => {
      const params: Parameters<typeof createChanges>[0] = { permissionMode: "read-only" };
      const changes = createChanges(params);
      const permission = changes.forAttempt();
      const failure = new Error("projection failed");
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const register = pluginStateWorker.registerPluginStateInWorker;
      const observer = vi
        .spyOn(pluginStateWorker, "registerPluginStateInWorker")
        .mockImplementation(async (input) => {
          await register(input).catch((error: unknown) => {
            reached.reject(error);
            throw error;
          });
          reached.resolve();
          await release.promise;
        });
      const pending = withPermission(permission.owner, "full", () =>
        withRuntimeToolSchemaQuarantine((record) => {
          record(logParams("tool", [], ["unsupported schema"]));
          if (throws) {
            throw failure;
          }
          permission.recordApplied("full");
        }),
      );
      const settled = vi.fn();
      const observed = pending.then(settled, settled);
      try {
        expect(params.permissionMode).toBe(throws ? "read-only" : "full");
        expect(() => permission.recordApplied("full")).toThrow("not authorized");
        await reached.promise;
        expect(settled).not.toHaveBeenCalled();
        release.resolve();
        await observed;
        expect(settled).toHaveBeenCalledExactlyOnceWith(throws ? failure : undefined);
        expect(await listQuarantines()).toEqual([
          { ...quarantine("tool"), failedAt: expect.any(Date) },
        ]);
      } finally {
        release.resolve();
        await observed;
        observer.mockRestore();
        changes.close();
      }
    });
  });
});
