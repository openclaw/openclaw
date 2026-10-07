/**
 * Host-scoped delegated ownership for before_dispatch plugins.
 *
 * These tests drive the real Host hook runner with a Host-owned delegation
 * scope, exactly as the dispatch integration does, and inspect the durable
 * ownership registry the Host writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDelegatedExecutionLineage } from "../delegation/delegated-execution-lineage.js";
import { listLiveOwnershipRows } from "../delegation/delegated-execution-ownership-store.js";
import { readDelegatedExecutionOwnership } from "../delegation/delegated-execution-ownership.js";
import type { DelegatedExecutionOwnershipRecord } from "../delegation/delegated-execution-ownership.types.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  BeforeDispatchDelegationRefusedError,
  createBeforeDispatchDelegationSlot,
  createPluginDelegationRuntime,
  deriveBeforeDispatchDelegationTaskScopeRef,
  readBeforeDispatchDelegationFrame,
  type BeforeDispatchDelegationSlot,
  type PluginDelegationEstablishment,
  type PluginDelegationRuntime,
} from "./before-dispatch-delegation.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-before-dispatch-delegation-");
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

function stateOptions(): OpenClawStateDatabaseOptions {
  return { env: process.env };
}

function liveRows(): DelegatedExecutionOwnershipRecord[] {
  return listLiveOwnershipRows(openOpenClawStateDatabase(stateOptions()).db);
}

function readOwnership(delegationRef: string): DelegatedExecutionOwnershipRecord | undefined {
  const lookup = readDelegatedExecutionOwnership({
    db: openOpenClawStateDatabase(stateOptions()).db,
    delegationRef,
  });
  return lookup.kind === "owned" ? lookup.record : undefined;
}

type BeforeDispatchHandler = (
  runtime: PluginDelegationRuntime,
) => Promise<{ handled: boolean; text?: string } | void>;

async function runBeforeDispatchWithDelegation(
  params: {
    hooks: Array<{
      pluginId: string;
      registrationId?: string;
      priority?: number;
      handler: BeforeDispatchHandler;
    }>;
    taskScopeRef?: string;
    context?: object;
    options?: OpenClawStateDatabaseOptions;
  } = { hooks: [] },
) {
  const runtime = createPluginDelegationRuntime();
  const registry = createMockPluginRegistry(
    params.hooks.map((hook) => ({
      hookName: "before_dispatch",
      pluginId: hook.pluginId,
      ...(hook.registrationId === undefined ? {} : { registrationId: hook.registrationId }),
      ...(hook.priority === undefined ? {} : { priority: hook.priority }),
      handler: () => hook.handler(runtime),
    })),
  );
  const runner = createHookRunner(registry);
  const slot = createBeforeDispatchDelegationSlot();
  const context: object = params.context ?? {};
  const taskScopeRef =
    params.taskScopeRef ?? deriveBeforeDispatchDelegationTaskScopeRef(["test", "msg-1"]);
  const result = await runner.runBeforeDispatch(
    { content: "hello", messageId: "msg-1", sessionKey: "agent:main:webchat:direct:1" },
    { sessionKey: "agent:main:webchat:direct:1", messageId: "msg-1" },
    undefined,
    {
      slot,
      taskScopeRef,
      context,
      ...(params.options === undefined ? {} : { options: params.options }),
    },
  );
  return { runtime, registry, runner, slot, context, taskScopeRef, result };
}

describe("before_dispatch delegated ownership (scoped establishCurrent)", () => {
  it("1. a before_dispatch plugin can establish delegation for the current turn", async () => {
    let handles: PluginDelegationEstablishment | undefined;
    const { slot, result } = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            handles = await runtime.establishCurrent();
            return { handled: true, text: "claimed" };
          },
        },
      ],
    });

    expect(slot.established).toBe(true);
    expect(result).toEqual({ handled: true, text: "claimed" });
    expect(handles?.delegationRef).toBeTruthy();
    const record = readOwnership(handles!.delegationRef);
    expect(record?.state).toBe("DELEGATED_LOCKED");
    expect(record?.ownerKind).toBe("plugin");
  });

  it("2. the Host derives the plugin owner identity; a plugin cannot override ownerId", async () => {
    let handles: PluginDelegationEstablishment | undefined;
    const { taskScopeRef } = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          registrationId: "reg-7",
          handler: async (runtime) => {
            handles = await (
              runtime.establishCurrent as (p: unknown) => Promise<PluginDelegationEstablishment>
            )({ ownerId: "attacker", ownerKind: "trusted-human" });
            return { handled: true };
          },
        },
      ],
    });
    const record = readOwnership(handles!.delegationRef);
    expect(record?.ownerKind).toBe("plugin");
    expect(record?.ownerId).toBe("owner-plugin/reg-7");
    expect(record?.taskScopeRef).toBe(taskScopeRef);
  });

  it("3. the Host derives the task scope; a plugin cannot inject taskScopeRef", async () => {
    let handles: PluginDelegationEstablishment | undefined;
    const { taskScopeRef } = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            handles = await (
              runtime.establishCurrent as (p: unknown) => Promise<PluginDelegationEstablishment>
            )({ taskScopeRef: "task:forged" });
            return { handled: true };
          },
        },
      ],
    });
    const record = readOwnership(handles!.delegationRef);
    expect(record?.taskScopeRef).toBe(taskScopeRef);
    expect(record?.taskScopeRef).not.toBe("task:forged");
  });

  it("4. delegation_ref and lineage_ref are Host-generated", async () => {
    let handles: PluginDelegationEstablishment | undefined;
    let context: object = {};
    const run = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            handles = await runtime.establishCurrent();
            return { handled: true };
          },
        },
      ],
    });
    context = run.context;
    const record = readOwnership(handles!.delegationRef);
    expect(handles!.delegationRef.startsWith("delegation:plugin:")).toBe(true);
    expect(handles!.lineageRef.startsWith("lineage:plugin:")).toBe(true);
    expect(record?.delegationRef).toBe(handles!.delegationRef);
    expect(record?.lineageRef).toBe(handles!.lineageRef);
    // The Host also binds the delegated lineage onto the execution context.
    expect(readDelegatedExecutionLineage(context)).toBe(handles!.lineageRef);
  });

  it("5. calling establishCurrent outside an active before_dispatch is refused", async () => {
    const runtime = createPluginDelegationRuntime();
    await expect(runtime.establishCurrent()).rejects.toBeInstanceOf(
      BeforeDispatchDelegationRefusedError,
    );
    await expect(runtime.establishCurrent()).rejects.toMatchObject({
      code: "outside-before-dispatch",
    });
    expect(liveRows()).toHaveLength(0);
  });

  it("6. a stale retained runtime capability is refused after the hook settles", async () => {
    let retained: PluginDelegationRuntime | undefined;
    await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            retained = runtime;
            await runtime.establishCurrent();
            return { handled: true };
          },
        },
      ],
    });
    await expect(retained!.establishCurrent()).rejects.toMatchObject({
      code: "outside-before-dispatch",
    });
  });

  it("7. repeated calls in the same turn are idempotent with no duplicate live rows", async () => {
    let first: PluginDelegationEstablishment | undefined;
    let second: PluginDelegationEstablishment | undefined;
    await runBeforeDispatchWithDelegation({
      taskScopeRef: deriveBeforeDispatchDelegationTaskScopeRef(["idempotency"]),
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            first = await runtime.establishCurrent();
            second = await runtime.establishCurrent();
            return { handled: true };
          },
        },
      ],
    });
    expect(second).toEqual(first);
    expect(liveRows()).toHaveLength(1);
  });

  it("8. successful establish + handled=true stops ordinary dispatch", async () => {
    const run = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            await runtime.establishCurrent();
            return { handled: true, text: "done" };
          },
        },
      ],
    });
    expect(run.slot.established).toBe(true);
    expect(run.result?.handled).toBe(true);
    // dispatch-from-config.choose-route stops ordinary dispatch when handled.
    expect(ordinaryDispatchWouldContinue(run.slot, run.result)).toBe(false);
  });

  it("9. successful establish + handled=false STILL stops ordinary dispatch", async () => {
    const run = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            await runtime.establishCurrent();
            return { handled: false };
          },
        },
      ],
    });
    expect(run.result).toBeUndefined();
    expect(run.slot.established).toBe(true);
    // The Host-owned slot, not the plugin result, is authoritative.
    expect(ordinaryDispatchWouldContinue(run.slot, run.result)).toBe(false);
  });

  it("10. successful establish + hook throw STILL stops ordinary dispatch", async () => {
    const run = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            await runtime.establishCurrent();
            throw new Error("boom after establishment");
          },
        },
      ],
    });
    expect(run.result).toBeUndefined();
    expect(run.slot.established).toBe(true);
    expect(ordinaryDispatchWouldContinue(run.slot, run.result)).toBe(false);
    // The durable lock survives the throw.
    expect(liveRows()).toHaveLength(1);
  });

  it("11. no establish + handled=false preserves normal direct dispatch", async () => {
    const run = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async () => ({ handled: false }),
        },
      ],
    });
    expect(run.slot.established).toBe(false);
    expect(run.result).toBeUndefined();
    expect(ordinaryDispatchWouldContinue(run.slot, run.result)).toBe(true);
    expect(liveRows()).toHaveLength(0);
  });

  it("12. a structurally forged/other-owner attempt cannot establish delegation", async () => {
    let secondError: unknown;
    const run = await runBeforeDispatchWithDelegation({
      taskScopeRef: deriveBeforeDispatchDelegationTaskScopeRef(["forgery"]),
      hooks: [
        {
          pluginId: "owner-plugin",
          priority: 100,
          handler: async (runtime) => {
            await runtime.establishCurrent();
            return { handled: false };
          },
        },
        {
          pluginId: "intruder-plugin",
          priority: 0,
          handler: async (runtime) => {
            try {
              await runtime.establishCurrent();
            } catch (error) {
              secondError = error;
            }
            return { handled: true };
          },
        },
      ],
    });
    expect(secondError).toBeInstanceOf(BeforeDispatchDelegationRefusedError);
    expect((secondError as BeforeDispatchDelegationRefusedError).code).toBe("already-established");
    expect(liveRows()).toHaveLength(1);
    // The intruder did not inherit the establishment.
    expect(run.slot.ownerId).toBe("owner-plugin");
  });

  it("13. the lock exists BEFORE the delegate-side facade can run", async () => {
    const context: object = {};
    let stateAtDelegate: string | undefined;
    let ownerStateAtDelegate: string | undefined;
    let lineageAtDelegate: string | undefined;
    await runBeforeDispatchWithDelegation({
      context,
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            const handles = await runtime.establishCurrent();
            // This stands in for muse_agent_delegate, which the plugin may only
            // call after the Host established the lock. The Host execution
            // context already carries the delegated lineage at this point.
            const record = readOwnership(handles.delegationRef);
            stateAtDelegate = record?.state;
            ownerStateAtDelegate = record?.ownerState;
            lineageAtDelegate = readDelegatedExecutionLineage(context);
            return { handled: true };
          },
        },
      ],
    });
    expect(stateAtDelegate).toBe("DELEGATED_LOCKED");
    expect(ownerStateAtDelegate).toBe("available");
    expect(lineageAtDelegate).toContain("lineage:plugin:");
    expect(readDelegatedExecutionLineage(context)).toBe(lineageAtDelegate);
  });

  it("14. establishment does not grant action approval", async () => {
    let handles: PluginDelegationEstablishment | undefined;
    await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "owner-plugin",
          handler: async (runtime) => {
            handles = await runtime.establishCurrent();
            return { handled: true };
          },
        },
      ],
    });
    expect(Object.keys(handles!).toSorted()).toEqual(["delegationRef", "lineageRef"]);
    const runtime = createPluginDelegationRuntime();
    expect(Object.keys(runtime)).toEqual(["establishCurrent"]);
    const record = readOwnership(handles!.delegationRef);
    // No approval provenance is attached by establishment.
    expect(record?.authorityRef).toBeNull();
  });

  it("15. existing before_dispatch behavior is unchanged when the API is unused", async () => {
    // A caller that never passes a delegation scope keeps today's behavior.
    const registry = createMockPluginRegistry([
      {
        hookName: "before_dispatch",
        pluginId: "plain-plugin",
        handler: async () => ({ handled: true, text: "plain" }),
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeDispatch(
      { content: "hello", messageId: "msg-1", sessionKey: "s" },
      { sessionKey: "s", messageId: "msg-1" },
    );
    expect(result).toEqual({ handled: true, text: "plain" });

    // A scoped run that never calls establishCurrent is equally unchanged.
    const scoped = await runBeforeDispatchWithDelegation({
      hooks: [
        {
          pluginId: "plain-plugin",
          handler: async (runtime) => {
            expect(typeof runtime.establishCurrent).toBe("function");
            expect(readBeforeDispatchDelegationFrame()).toBeUndefined();
            return { handled: false };
          },
        },
      ],
    });
    expect(scoped.slot.established).toBe(false);
    expect(liveRows()).toHaveLength(0);
  });
});

/**
 * Mirrors the Host decision in dispatch-from-config.choose-route.ts: the
 * Host-owned delegation slot is authoritative, so an establishment stops
 * ordinary dispatch regardless of the hook result.
 */
function ordinaryDispatchWouldContinue(
  slot: BeforeDispatchDelegationSlot,
  result: { handled: boolean } | undefined,
): boolean {
  if (slot.established) {
    return false;
  }
  return result?.handled !== true;
}
