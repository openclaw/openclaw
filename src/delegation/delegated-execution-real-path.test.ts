/**
 * Real Host path integration tests for delegated execution ownership.
 *
 * These tests do not call the ownership subsystem directly as the entry point.
 * They enter through the production Host functions the runtime actually uses:
 *   - resolvePreparedRunAdmission(): the admission every embedded/CLI/worker run
 *     passes through before model work.
 *   - runBeforeToolCallHook(): the before_tool_call policy chain that runs before
 *     a tool executes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreparedRunAdmission } from "../agents/admitted-run-context.js";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.policy.js";
import { bindCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  bindDelegatedExecutionFallbackAuthority,
  bindDelegatedExecutionLineage,
} from "./delegated-execution-lineage.js";
import { prepareDelegatedExecutionOwnershipStartup } from "./delegated-execution-ownership-recovery.js";
import {
  acquireDelegatedExecutionOwnership,
  authorizeTrustedHumanFallback,
  releaseDelegatedExecutionOwnership,
} from "./delegated-execution-ownership.js";
import { DelegatedExecutionDeniedError } from "./delegated-execution-run-admission.js";
import { mintTrustedHumanFallbackAuthority } from "./trusted-human-fallback-authority.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The wired Host gates resolve the shared state database from the process
// environment, exactly as the runtime does. The fixture must drive the same
// environment or the real path would read a different registry.
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-delegated-real-path-");
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

/** The exact context shape the runtime hands to resolvePreparedRunAdmission. */
function admittedRunContext(runId: string, lineageRef?: string) {
  const context = {
    operationalRunInstance: Object.freeze({ instanceId: "instance:" + runId, runId }),
  };
  if (lineageRef) {
    bindDelegatedExecutionLineage(context, lineageRef);
  }
  return context;
}

function seedLock(params: { delegationRef: string; lineageRef: string }) {
  acquireDelegatedExecutionOwnership({
    delegationRef: params.delegationRef,
    ownerKind: "plugin",
    ownerId: "delegate-plugin",
    taskScopeRef: "task:" + params.delegationRef,
    lineageRef: params.lineageRef,
    options: stateOptions(),
  });
  return openRegistry();
}

function mintFallback(delegationRef: string) {
  const ingress = {};
  bindCommandOwnerAuthority(ingress, { isCurrent: () => true });
  return mintTrustedHumanFallbackAuthority({
    ingressContext: ingress,
    ingress: { ingressRef: "channel:test", ownerRef: "owner:test" },
    delegationRef,
    intent: "fallback",
    authorityRef: "authority:real-path",
  });
}

describe("real Host path — agent execution admission", () => {
  it("denies a delegated locked lineage before model work starts", async () => {
    seedLock({ delegationRef: "delegation:rp-1", lineageRef: "lineage:rp-1" });
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:rp-1",
        runtimeKind: "embedded",
        admittedRunContext: admittedRunContext("run:rp-1", "lineage:rp-1"),
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("denies a delegated locked lineage when the delegate plugin is missing", async () => {
    // No plugin is loaded in this process at all.
    seedLock({ delegationRef: "delegation:rp-2", lineageRef: "lineage:rp-2" });
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:rp-2",
        runtimeKind: "embedded",
        admittedRunContext: admittedRunContext("run:rp-2", "lineage:rp-2"),
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("denies a delegated locked lineage when the delegate handler is missing", async () => {
    seedLock({ delegationRef: "delegation:rp-3", lineageRef: "lineage:rp-3" });
    const decision = await resolvePreparedRunAdmission({
      runId: "run:rp-3",
      runtimeKind: "embedded",
      admittedRunContext: admittedRunContext("run:rp-3", "lineage:rp-3"),
    }).catch((error: unknown) => error);
    expect(decision).toBeInstanceOf(DelegatedExecutionDeniedError);
    expect((decision as DelegatedExecutionDeniedError).code).toBe("delegated-ownership-locked");
  });

  it("denies a delegated locked lineage after a Gateway restart and rehydration", async () => {
    seedLock({ delegationRef: "delegation:rp-4", lineageRef: "lineage:rp-4" });
    closeOpenClawStateDatabaseForTest();
    const reopened = openRegistry();
    const rehydration = prepareDelegatedExecutionOwnershipStartup({ db: reopened.db });
    expect(rehydration.byRef.has("delegation:rp-4")).toBe(true);
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:rp-4",
        runtimeKind: "embedded",
        admittedRunContext: admittedRunContext("run:rp-4", "lineage:rp-4"),
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("leaves unrelated execution unaffected", async () => {
    seedLock({ delegationRef: "delegation:rp-5", lineageRef: "lineage:rp-5" });
    const admitted = await resolvePreparedRunAdmission({
      runId: "run:rp-unrelated",
      runtimeKind: "embedded",
      admittedRunContext: admittedRunContext("run:rp-unrelated", "lineage:unrelated"),
    });
    expect(admitted.operationalRunInstance.runId).toBe("run:rp-unrelated");
    const unbound = await resolvePreparedRunAdmission({
      runId: "run:rp-unbound",
      runtimeKind: "embedded",
      admittedRunContext: admittedRunContext("run:rp-unbound"),
    });
    expect(unbound.operationalRunInstance.runId).toBe("run:rp-unbound");
  });

  it("allows the exact lineage once a trusted human fallback is authorized", async () => {
    seedLock({ delegationRef: "delegation:rp-6", lineageRef: "lineage:rp-6" });
    const authority = mintFallback("delegation:rp-6");
    authorizeTrustedHumanFallback({
      delegationRef: "delegation:rp-6",
      authority,
      options: stateOptions(),
    });
    const context = admittedRunContext("run:rp-6", "lineage:rp-6");
    bindDelegatedExecutionFallbackAuthority(context, authority);
    const admitted = await resolvePreparedRunAdmission({
      runId: "run:rp-6",
      runtimeKind: "embedded",
      admittedRunContext: context,
    });
    expect(admitted.operationalRunInstance.runId).toBe("run:rp-6");
  });

  it("denies an authorized fallback lineage that carries no live authority", async () => {
    seedLock({ delegationRef: "delegation:rp-9", lineageRef: "lineage:rp-9" });
    authorizeTrustedHumanFallback({
      delegationRef: "delegation:rp-9",
      authority: mintFallback("delegation:rp-9"),
      options: stateOptions(),
    });
    // FALLBACK_AUTHORIZED alone is not sufficient: the execution must carry the
    // exact live authority, so a model or tool argument cannot self-authorize.
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:rp-9",
        runtimeKind: "embedded",
        admittedRunContext: admittedRunContext("run:rp-9", "lineage:rp-9"),
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });

  it("does not apply a stale denial after a terminal release", async () => {
    seedLock({ delegationRef: "delegation:rp-7", lineageRef: "lineage:rp-7" });
    releaseDelegatedExecutionOwnership({
      delegationRef: "delegation:rp-7",
      event: "DELEGATE_TERMINAL_COMPLETED",
      actorKind: "delegate",
      actorRef: "delegate-plugin",
      options: stateOptions(),
    });
    const admitted = await resolvePreparedRunAdmission({
      runId: "run:rp-7",
      runtimeKind: "embedded",
      admittedRunContext: admittedRunContext("run:rp-7", "lineage:rp-7"),
    });
    expect(admitted.operationalRunInstance.runId).toBe("run:rp-7");
  });

  it("fails closed on an unreadable ownership registry for a delegated lineage", async () => {
    // A directory where the state database file should be makes the registry unopenable.
    const brokenRoot = tempDirs.make("openclaw-delegated-broken-");
    const { mkdirSync } = await import("node:fs");
    // A directory where the state database file belongs makes the registry unopenable.
    mkdirSync(brokenRoot + "/state/openclaw.sqlite", { recursive: true });
    const admitted = admittedRunContext("run:rp-8", "lineage:rp-8");
    closeOpenClawStateDatabaseForTest();
    process.env.OPENCLAW_STATE_DIR = brokenRoot;
    await expect(
      resolvePreparedRunAdmission({
        runId: "run:rp-8",
        runtimeKind: "embedded",
        admittedRunContext: admitted,
      }),
    ).rejects.toBeInstanceOf(DelegatedExecutionDeniedError);
  });
});

describe("real Host path — tool execution admission", () => {
  it("denies a protected tool for a delegated locked lineage before it executes", async () => {
    seedLock({ delegationRef: "delegation:rp-t1", lineageRef: "lineage:rp-t1" });
    const ctx: Record<string, unknown> = { runId: "run:rp-t1", sessionKey: "session:rp-t1" };
    bindDelegatedExecutionLineage(ctx, "lineage:rp-t1");
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hi" },
      ctx: ctx as never,
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.deniedReason).toBe("delegated-execution-ownership");
  });

  it("denies a protected tool with no plugins loaded", async () => {
    seedLock({ delegationRef: "delegation:rp-t2", lineageRef: "lineage:rp-t2" });
    const ctx: Record<string, unknown> = { runId: "run:rp-t2" };
    bindDelegatedExecutionLineage(ctx, "lineage:rp-t2");
    const outcome = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: ctx as never,
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.deniedReason).toBe("delegated-execution-ownership");
  });

  it("denies a protected tool for an unavailable owner after restart", async () => {
    seedLock({ delegationRef: "delegation:rp-t3", lineageRef: "lineage:rp-t3" });
    closeOpenClawStateDatabaseForTest();
    const reopened = openRegistry();
    prepareDelegatedExecutionOwnershipStartup({ db: reopened.db });
    const ctx: Record<string, unknown> = { runId: "run:rp-t3" };
    bindDelegatedExecutionLineage(ctx, "lineage:rp-t3");
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: ctx as never,
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.deniedReason).toBe("delegated-execution-ownership");
  });

  it("does not deny an unrelated tool call", async () => {
    seedLock({ delegationRef: "delegation:rp-t4", lineageRef: "lineage:rp-t4" });
    const ctx: Record<string, unknown> = { runId: "run:rp-t4" };
    bindDelegatedExecutionLineage(ctx, "lineage:unrelated");
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: ctx as never,
    });
    expect(outcome.deniedReason).not.toBe("delegated-execution-ownership");
  });
});
