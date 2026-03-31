import { describe, expect, it } from "vitest";
import {
  clearOperationsRuntimeState,
  getRegisteredOperationsRuntime,
  getRegisteredOperationsRuntimeOwner,
  registerOperationsRuntimeForOwner,
  restoreOperationsRuntimeState,
  summarizeOperationRecords,
  type PluginOperationsRuntime,
} from "./operations-state.js";

function createRuntime(label: string): PluginOperationsRuntime {
  return {
    async dispatch() {
      return { matched: true, created: true, record: null };
    },
    async getById() {
      return null;
    },
    async findByRunId() {
      return null;
    },
    async list() {
      return [];
    },
    async summarize() {
      return {
        total: 0,
        active: 0,
        terminal: 0,
        failures: 0,
        byNamespace: { [label]: 0 },
        byKind: {},
        byStatus: {},
      };
    },
    async audit() {
      return [];
    },
    async maintenance() {
      return {
        reconciled: 0,
        cleanupStamped: 0,
        pruned: 0,
      };
    },
    async cancel() {
      return { found: false, cancelled: false, reason: label };
    },
  };
}

describe("operations-state", () => {
  it("registers an operations runtime and tracks the owner", () => {
    clearOperationsRuntimeState();
    const runtime = createRuntime("one");
    expect(registerOperationsRuntimeForOwner(runtime, "plugin-one")).toEqual({ ok: true });
    expect(getRegisteredOperationsRuntime()).toBe(runtime);
    expect(getRegisteredOperationsRuntimeOwner()).toBe("plugin-one");
  });

  it("rejects a second owner and allows same-owner refresh", () => {
    clearOperationsRuntimeState();
    const first = createRuntime("one");
    const second = createRuntime("two");
    const replacement = createRuntime("three");
    expect(registerOperationsRuntimeForOwner(first, "plugin-one")).toEqual({ ok: true });
    expect(registerOperationsRuntimeForOwner(second, "plugin-two")).toEqual({
      ok: false,
      existingOwner: "plugin-one",
    });
    expect(
      registerOperationsRuntimeForOwner(replacement, "plugin-one", {
        allowSameOwnerRefresh: true,
      }),
    ).toEqual({ ok: true });
    expect(getRegisteredOperationsRuntime()).toBe(replacement);
  });

  it("restores and clears runtime state", () => {
    clearOperationsRuntimeState();
    const runtime = createRuntime("restore");
    restoreOperationsRuntimeState({
      runtime,
      ownerPluginId: "plugin-restore",
    });
    expect(getRegisteredOperationsRuntime()).toBe(runtime);
    expect(getRegisteredOperationsRuntimeOwner()).toBe("plugin-restore");
    clearOperationsRuntimeState();
    expect(getRegisteredOperationsRuntime()).toBeUndefined();
    expect(getRegisteredOperationsRuntimeOwner()).toBeUndefined();
  });

  it("summarizes generic operation records", () => {
    const summary = summarizeOperationRecords([
      {
        operationId: "op-1",
        namespace: "tasks",
        kind: "cli",
        status: "queued",
        description: "Queued task",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        operationId: "op-2",
        namespace: "imports",
        kind: "csv",
        status: "failed",
        description: "Failed import",
        createdAt: 2,
        updatedAt: 2,
      },
    ]);
    expect(summary).toEqual({
      total: 2,
      active: 1,
      terminal: 1,
      failures: 1,
      byNamespace: {
        imports: 1,
        tasks: 1,
      },
      byKind: {
        cli: 1,
        csv: 1,
      },
      byStatus: {
        failed: 1,
        queued: 1,
      },
    });
  });
});
