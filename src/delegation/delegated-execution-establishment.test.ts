/**
 * Host-owned delegated execution establishment — real Host path acceptance.
 *
 * These tests start from the Host delegation establishment seam, not from a
 * seeded ownership row and not from a direct `bindDelegatedExecutionLineage`
 * call at the final run/tool boundary. They then drive the real execution paths
 * the runtime uses:
 *   - resolvePreparedRunAdmission(): admission every embedded run passes before
 *     model work.
 *   - runBeforeToolCallHook(): the before_tool_call policy chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreparedRunAdmission } from "../agents/admitted-run-context.js";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.policy.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  inheritDelegatedExecutionLineageForChild,
  resolveChildDelegatedExecutionLineage,
  withParentDelegatedExecutionLineage,
} from "./delegated-execution-child.js";
import { establishDelegatedExecutionOwnership } from "./delegated-execution-establishment.js";
import { readDelegatedExecutionLineage } from "./delegated-execution-lineage.js";
import { readDelegatedExecutionOwnership } from "./delegated-execution-ownership.js";
import { DelegatedExecutionDeniedError } from "./delegated-execution-run-admission.js";
import {
  readCurrentDelegatedExecutionLineage,
  runWithDelegatedExecutionLineage,
} from "./delegated-execution-scope.js";
import { createHostDelegationIntent } from "./host-delegation-intent.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-delegated-establishment-");
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

function stateOptions() {
  return { env: process.env };
}

function openRegistry() {
  return openOpenClawStateDatabase(stateOptions());
}

function readOwnership(delegationRef: string) {
  return readDelegatedExecutionOwnership({ db: openRegistry().db, delegationRef });
}

/** The exact context shape the runtime hands to resolvePreparedRunAdmission. */
function executionContext(runId: string): Record<string, unknown> {
  return { operationalRunInstance: Object.freeze({ instanceId: "instance:" + runId, runId }) };
}

describe("delegated execution establishment — lock before handoff", () => {
  it("commits DELEGATED_LOCKED before the delegate owner callback is invoked", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-1",
      delegationRef: "delegation:est-1",
      lineageRef: "lineage:est-1",
    });
    const context = executionContext("run:est-1");
    let handoffInvoked = false;
    let stateAtHandoff: string | undefined;
    const establishment = await establishDelegatedExecutionOwnership({
      intent,
      context,
      delegate: () => {
        handoffInvoked = true;
        const lookup = readOwnership("delegation:est-1");
        stateAtHandoff = lookup.kind === "owned" ? lookup.record.state : "missing";
        // The Host context must already carry the lineage before the handoff.
        expect(readDelegatedExecutionLineage(context)).toBe("lineage:est-1");
        return { kind: "owner-available", delegateGoalRef: "goal:est-1" };
      },
      options: stateOptions(),
    });
    expect(handoffInvoked).toBe(true);
    expect(stateAtHandoff).toBe("DELEGATED_LOCKED");
    expect(establishment.locked).toBe(true);
    expect(establishment.handoff).toBe("owner-available");
    expect(readDelegatedExecutionLineage(context)).toBe("lineage:est-1");
  });

  it("refuses a forged delegation intent and creates no ownership", async () => {
    const context = executionContext("run:est-forge");
    const forged = {
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:forge",
      delegationRef: "delegation:forge",
      lineageRef: "lineage:forge",
      delegateGoalRef: null,
    };
    await expect(
      establishDelegatedExecutionOwnership({
        intent: forged as never,
        context,
        delegate: () => ({ kind: "owner-available", delegateGoalRef: "goal:forge" }),
        options: stateOptions(),
      }),
    ).rejects.toThrow(/Host-minted/);
    expect(readOwnership("delegation:forge").kind).toBe("direct");
    expect(readDelegatedExecutionLineage(context)).toBeUndefined();
  });
});

describe("delegated execution establishment — owner absence and failure fail closed", () => {
  it("keeps the lock and denies ordinary execution when the delegate plugin/handler is missing", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-2",
      delegationRef: "delegation:est-2",
      lineageRef: "lineage:est-2",
    });
    const context = executionContext("run:est-2");
    const establishment = await establishDelegatedExecutionOwnership({
      intent,
      context,
      // No plugin, no hook, no handler is registered in this process.
      delegate: () => ({ kind: "owner-unavailable", reason: "no before_dispatch owner handler" }),
      options: stateOptions(),
    });
    expect(establishment.handoff).toBe("owner-unavailable");
    expect(establishment.locked).toBe(true);
    const lookup = readOwnership("delegation:est-2");
    expect(lookup.kind).toBe("owned");
    if (lookup.kind === "owned") {
      expect(lookup.record.state).toBe("DELEGATED_LOCKED");
      expect(lookup.record.ownerState).toBe("unavailable");
      expect(lookup.record.lastEvent).toBe("DELEGATE_OWNER_UNAVAILABLE");
    }
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:est-2",
        runtimeKind: "embedded",
        admittedRunContext: context as never,
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("keeps the lock when the delegate handler throws", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-3",
      delegationRef: "delegation:est-3",
      lineageRef: "lineage:est-3",
    });
    const context = executionContext("run:est-3");
    const establishment = await establishDelegatedExecutionOwnership({
      intent,
      context,
      delegate: () => {
        throw new Error("delegate handler exploded");
      },
      options: stateOptions(),
    });
    expect(establishment.handoff).toBe("handoff-failed");
    const lookup = readOwnership("delegation:est-3");
    if (lookup.kind !== "owned") {
      throw new Error("ownership record missing");
    }
    expect(lookup.record.state).toBe("DELEGATED_LOCKED");
    expect(lookup.record.lastEvent).toBe("DELEGATE_OWNER_UNAVAILABLE");
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hi" },
      ctx: context as never,
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.deniedReason).toBe("delegated-execution-ownership");
  });
});

describe("delegated execution establishment — automatic lineage propagation", () => {
  it("flows lineage from establishment into agent admission without a final-stage binding", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-4",
      delegationRef: "delegation:est-4",
      lineageRef: "lineage:est-4",
    });
    const context = executionContext("run:est-4");
    await establishDelegatedExecutionOwnership({
      intent,
      context,
      delegate: () => ({ kind: "owner-available", delegateGoalRef: "goal:est-4" }),
      options: stateOptions(),
    });
    // No test-side bindDelegatedExecutionLineage: the establishment bound the
    // lineage, and admission must deny while the lock is retained.
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:est-4",
        runtimeKind: "embedded",
        admittedRunContext: context as never,
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("propagates lineage through the Host delegated scope to nested execution", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-scope",
      delegationRef: "delegation:est-scope",
      lineageRef: "lineage:est-scope",
    });
    const established = executionContext("run:est-scope");
    await establishDelegatedExecutionOwnership({
      intent,
      context: established,
      delegate: () => ({ kind: "owner-available", delegateGoalRef: "goal:est-scope" }),
      options: stateOptions(),
    });
    // A nested execution with no explicit context binding still inherits the
    // lineage because it runs inside the Host-owned delegated scope.
    await runWithDelegatedExecutionLineage("lineage:est-scope", async () => {
      expect(readCurrentDelegatedExecutionLineage()).toBe("lineage:est-scope");
      await expect(
        resolvePreparedRunAdmission({
          runId: "run:est-scope-nested",
          runtimeKind: "embedded",
          admittedRunContext: executionContext("run:est-scope-nested") as never,
        }),
      ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
    });
  });

  it("denies a protected tool automatically for the established lineage", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-5",
      delegationRef: "delegation:est-5",
      lineageRef: "lineage:est-5",
    });
    const context = executionContext("run:est-5");
    await establishDelegatedExecutionOwnership({
      intent,
      context,
      delegate: () => ({ kind: "owner-unavailable", reason: "owner missing" }),
      options: stateOptions(),
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hi" },
      ctx: context as never,
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.deniedReason).toBe("delegated-execution-ownership");
  });
});

describe("delegated execution establishment — child inheritance", () => {
  it("lets a child of a delegated parent inherit the delegated lineage", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-6",
      delegationRef: "delegation:est-6",
      lineageRef: "lineage:est-6",
    });
    const parentContext = executionContext("run:est-6");
    await establishDelegatedExecutionOwnership({
      intent,
      context: parentContext,
      delegate: () => ({ kind: "owner-available", delegateGoalRef: "goal:est-6" }),
      options: stateOptions(),
    });
    const childContext = executionContext("run:est-6-child");
    const inherited = inheritDelegatedExecutionLineageForChild({ parentContext, childContext });
    expect(inherited).toBe("lineage:est-6");
    expect(readDelegatedExecutionLineage(childContext)).toBe("lineage:est-6");
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:est-6-child",
        runtimeKind: "embedded",
        admittedRunContext: childContext as never,
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("does not invent a lineage for a child of an unrelated parent", async () => {
    const lockedParent = executionContext("run:est-7-parent");
    await establishDelegatedExecutionOwnership({
      intent: createHostDelegationIntent({
        ownerKind: "plugin",
        ownerId: "delegate-plugin",
        taskScopeRef: "task:est-7",
        delegationRef: "delegation:est-7",
        lineageRef: "lineage:est-7",
      }),
      context: lockedParent,
      delegate: () => ({ kind: "owner-available", delegateGoalRef: "goal:est-7" }),
      options: stateOptions(),
    });
    // An unrelated parent: no Host-bound delegated lineage and no delegated scope.
    const unrelatedParent: Record<string, unknown> = {};
    expect(resolveChildDelegatedExecutionLineage(unrelatedParent)).toBeUndefined();
    const childContext = executionContext("run:est-7-child");
    expect(
      inheritDelegatedExecutionLineageForChild({ parentContext: unrelatedParent, childContext }),
    ).toBeUndefined();
    const admitted = await resolvePreparedRunAdmission({
      runId: "run:est-7-child",
      runtimeKind: "embedded",
      admittedRunContext: childContext as never,
    });
    expect(admitted.operationalRunInstance.runId).toBe("run:est-7-child");
    // A Host-bound parent capability still carries the relation across a copy.
    const carried = withParentDelegatedExecutionLineage({}, "lineage:est-7");
    expect(resolveChildDelegatedExecutionLineage(carried)).toBe("lineage:est-7");
  });
});

describe("delegated execution establishment — owner available", () => {
  it("records the owner available and attaches delegate_goal_ref while staying locked", async () => {
    const intent = createHostDelegationIntent({
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      taskScopeRef: "task:est-8",
      delegationRef: "delegation:est-8",
      lineageRef: "lineage:est-8",
    });
    const context = executionContext("run:est-8");
    const establishment = await establishDelegatedExecutionOwnership({
      intent,
      context,
      delegate: () => ({ kind: "owner-available", delegateGoalRef: "goal:est-8" }),
      options: stateOptions(),
    });
    expect(establishment.handoff).toBe("owner-available");
    expect(establishment.ownerState).toBe("available");
    expect(establishment.delegateGoalRef).toBe("goal:est-8");
    expect(establishment.record.state).toBe("DELEGATED_LOCKED");
    expect(establishment.locked).toBe(true);
    const lookup = readOwnership("delegation:est-8");
    if (lookup.kind !== "owned") {
      throw new Error("ownership record missing");
    }
    expect(lookup.record.state).toBe("DELEGATED_LOCKED");
    expect(lookup.record.delegateGoalRef).toBe("goal:est-8");
    expect(lookup.record.lastEvent).toBe("DELEGATE_OWNER_AVAILABLE");
  });
});
