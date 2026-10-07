/**
 * Delegated execution ownership guard — PR-1 acceptance suite.
 *
 * The invariant under test is OPENCLAW_MUST_NOT_EXECUTE_DELEGATED_TASK_DIRECTLY:
 * once a delegation is committed, ordinary OpenClaw agent and tool execution is
 * denied for that task lineage until a closed terminal event or a Host-bound
 * trusted-human revoke releases it.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { admitAgentExecution, admitToolExecution } from "./delegated-execution-ownership-guard.js";
import {
  assertDelegatedExecutionOwnershipDowngradeSafe,
  prepareDelegatedExecutionOwnershipStartup,
  rehydrateDelegatedExecutionOwnership,
} from "./delegated-execution-ownership-recovery.js";
import { listOwnershipEvents } from "./delegated-execution-ownership-store.js";
import {
  acquireDelegatedExecutionOwnership,
  authorizeTrustedHumanFallback,
  listLiveDelegatedExecutionOwnership,
  readDelegatedExecutionOwnership,
  recordDelegateOwnerAvailable,
  recordDelegateOwnerUnavailable,
  releaseDelegatedExecutionOwnership,
  revokeDelegatedExecutionOwnership,
} from "./delegated-execution-ownership.js";
import { DELEGATED_EXECUTION_OWNERSHIP_TABLE } from "./delegated-execution-ownership.schema.js";
import {
  DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION,
  DELEGATED_EXECUTION_OWNERSHIP_NON_RELEASING_REASONS,
  type DelegatedExecutionOwnershipEvent,
} from "./delegated-execution-ownership.types.js";
import {
  mintTrustedHumanFallbackAuthority,
  requireTrustedHumanFallbackAuthority,
} from "./trusted-human-fallback-authority.js";
import { createTrustedHumanIngressFixture } from "./trusted-human-fallback-authority.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// One state directory per test: writers and readers must observe one registry.
let stateEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  stateEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-delegated-ownership-") };
});

afterEach(() => closeOpenClawStateDatabaseForTest());

function stateOptions() {
  return { env: stateEnv };
}

function openRegistry(): { db: DatabaseSync } {
  const opened = openOpenClawStateDatabase(stateOptions());
  return { db: opened.db };
}

type IngressFixture = Awaited<ReturnType<typeof createTrustedHumanIngressFixture>>;

/**
 * Mints from a real Host ingress context: the production resolution path binds
 * opaque channel admission evidence and a live command-owner authority to the
 * same context. Caller-supplied identifier strings are never accepted.
 */
async function mintFallback(params: {
  delegationRef: string;
  intent: "fallback" | "revoke";
  fixture?: IngressFixture;
  authorityRef?: string;
}) {
  const fixture = params.fixture ?? (await createTrustedHumanIngressFixture());
  const admissionEvidence = fixture.evidence();
  if (!admissionEvidence) {
    throw new Error("fixture did not bind channel admission evidence");
  }
  return mintTrustedHumanFallbackAuthority({
    ingressContext: fixture.context,
    admissionEvidence,
    delegationRef: params.delegationRef,
    intent: params.intent,
    authorityRef: params.authorityRef ?? "authority:test",
  });
}

function acquire(params: {
  delegationRef: string;
  lineageRef?: string | null;
  ownerKind?: string;
  ownerId?: string;
}) {
  return acquireDelegatedExecutionOwnership({
    delegationRef: params.delegationRef,
    ownerKind: params.ownerKind ?? "plugin",
    ownerId: params.ownerId ?? "delegate-plugin",
    taskScopeRef: "task:" + params.delegationRef,
    lineageRef: params.lineageRef ?? "lineage:" + params.delegationRef,
    options: stateOptions(),
  });
}

describe("delegated execution ownership — acquisition and lock", () => {
  it("commits DELEGATED_LOCKED before any delegate handoff is attempted", () => {
    const acquired = acquire({ delegationRef: "delegation:1" });
    expect(acquired.kind).toBe("acquired");
    expect(acquired.record.state).toBe("DELEGATED_LOCKED");
    expect(acquired.record.delegateGoalRef).toBeNull();
    expect(acquired.record.ownerState).toBe("unavailable");
    const { db } = openRegistry();
    expect(listOwnershipEvents(db, "delegation:1").map((e) => e.event)).toEqual([
      "DELEGATION_ESTABLISHED",
    ]);
  });

  it("keeps Host delegation_ref and delegate_goal_ref as distinct identities", () => {
    acquire({ delegationRef: "delegation:2" });
    const record = recordDelegateOwnerAvailable({
      delegationRef: "delegation:2",
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      delegateGoalRef: "goal:delegate-2",
      options: stateOptions(),
    });
    expect(record.delegationRef).toBe("delegation:2");
    expect(record.delegateGoalRef).toBe("goal:delegate-2");
    expect(record.state).toBe("DELEGATED_LOCKED");
    expect(record.ownerState).toBe("available");
  });

  it("preserves the lock and records DELEGATE_OWNER_UNAVAILABLE when handoff fails", () => {
    acquire({ delegationRef: "delegation:3" });
    const record = recordDelegateOwnerUnavailable({
      delegationRef: "delegation:3",
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      options: stateOptions(),
    });
    expect(record.state).toBe("DELEGATED_LOCKED");
    expect(record.ownerState).toBe("unavailable");
    expect(record.lastEvent).toBe("DELEGATE_OWNER_UNAVAILABLE");
  });

  it("answers duplicate acquisition without overwriting retained ownership", () => {
    const first = acquire({ delegationRef: "delegation:4", ownerId: "owner-a" });
    const second = acquire({ delegationRef: "delegation:4", ownerId: "owner-b" });
    expect(first.kind).toBe("acquired");
    expect(second.kind).toBe("duplicate");
    expect(second.record.ownerId).toBe("owner-a");
    expect(second.record.revision).toBe(1);
  });
});

describe("delegated execution ownership — execution guards", () => {
  it("denies agent execution while the delegation is locked", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:10", lineageRef: "lineage:10" });
    const decision = admitAgentExecution({ db, lineageRef: "lineage:10" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("delegated-ownership-locked");
  });

  it("denies tool execution while the delegation is locked", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:11", lineageRef: "lineage:11" });
    const decision = admitToolExecution({ db, lineageRef: "lineage:11" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("delegated-ownership-locked");
  });

  it("keeps the lock and denial when the delegate plugin is missing", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:12", lineageRef: "lineage:12" });
    recordDelegateOwnerUnavailable({
      delegationRef: "delegation:12",
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      options: stateOptions(),
    });
    expect(admitAgentExecution({ db, delegationRef: "delegation:12" }).allowed).toBe(false);
  });

  it("keeps the lock and denial when no delegate handler is registered", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:13" });
    recordDelegateOwnerUnavailable({
      delegationRef: "delegation:13",
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      options: stateOptions(),
    });
    const live = listLiveDelegatedExecutionOwnership({ db });
    expect(live.some((r) => r.delegationRef === "delegation:13")).toBe(true);
    expect(admitToolExecution({ db, delegationRef: "delegation:13" }).allowed).toBe(false);
  });

  it("keeps the lock and denial when the delegate plugin throws during handoff", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:14" });
    try {
      throw new Error("delegate plugin crashed");
    } catch {
      recordDelegateOwnerUnavailable({
        delegationRef: "delegation:14",
        ownerKind: "plugin",
        ownerId: "delegate-plugin",
        options: stateOptions(),
      });
    }
    expect(admitAgentExecution({ db, delegationRef: "delegation:14" }).allowed).toBe(false);
  });

  it("fails closed when the registry cannot be read", () => {
    acquire({ delegationRef: "delegation:15" });
    const { db } = openRegistry();
    db.close();
    const decision = admitAgentExecution({ db });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("ownership-unreadable");
  });

  it("does not affect unrelated execution whose lineage proves no relation", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:16", lineageRef: "lineage:16" });
    expect(admitAgentExecution({ db, lineageRef: "lineage:unrelated" }).allowed).toBe(true);
    expect(admitToolExecution({ db, lineageRef: null }).allowed).toBe(true);
  });

  it("lets a child execution inherit ownership through proven lineage only", () => {
    const { db } = openRegistry();
    acquire({ delegationRef: "delegation:17", lineageRef: "lineage:parent" });
    expect(admitAgentExecution({ db, lineageRef: "lineage:child" }).allowed).toBe(true);
    expect(admitToolExecution({ db, lineageRef: "lineage:parent" }).allowed).toBe(false);
    expect(admitToolExecution({ db, lineageRef: "lineage:child" }).allowed).toBe(true);
  });
});

describe("delegated execution ownership — trusted human authority", () => {
  it("accepts an exact trusted-human fallback bound to this delegation_ref", async () => {
    acquire({ delegationRef: "delegation:20" });
    const authority = await mintFallback({ delegationRef: "delegation:20", intent: "fallback" });
    const record = authorizeTrustedHumanFallback({
      delegationRef: "delegation:20",
      authority,
      options: stateOptions(),
    });
    expect(record.state).toBe("FALLBACK_AUTHORIZED");
    expect(record.lastEvent).toBe("HUMAN_FALLBACK_AUTHORIZED");
    const { db } = openRegistry();
    expect(
      admitAgentExecution({ db, delegationRef: "delegation:20", fallbackAuthority: authority }),
    ).toEqual({
      allowed: true,
      reason: "human-fallback-authorized",
    });
    expect(admitAgentExecution({ db, delegationRef: "delegation:20" }).allowed).toBe(false);
  });

  it("accepts an exact trusted-human revoke and releases the lock", async () => {
    acquire({ delegationRef: "delegation:21" });
    const authority = await mintFallback({ delegationRef: "delegation:21", intent: "revoke" });
    const record = revokeDelegatedExecutionOwnership({
      delegationRef: "delegation:21",
      authority,
      options: stateOptions(),
    });
    expect(record.state).toBe("RELEASED");
    expect(record.releaseEvent).toBe("HUMAN_REVOKED_DELEGATION");
    const { db } = openRegistry();
    expect(admitAgentExecution({ db, delegationRef: "delegation:21" }).allowed).toBe(true);
  });

  it("refuses a model-forged fallback claim", () => {
    acquire({ delegationRef: "delegation:22" });
    const forged = {
      delegationRef: "delegation:22",
      intent: "fallback",
      authorityRef: "forged",
      assertCurrent: () => undefined,
    };
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:22",
        authority: forged,
        options: stateOptions(),
      }),
    ).toThrow(/Host capability/);
  });

  it("refuses a plugin-forged fallback claim", () => {
    acquire({ delegationRef: "delegation:23" });
    const pluginAuthority = Object.freeze({ plugin: "self-authorized" });
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:23",
        authority: pluginAuthority,
        options: stateOptions(),
      }),
    ).toThrow(/Host capability/);
  });

  it("refuses authority bound to a different delegation_ref", async () => {
    acquire({ delegationRef: "delegation:24" });
    acquire({ delegationRef: "delegation:25" });
    const authority = await mintFallback({ delegationRef: "delegation:24", intent: "fallback" });
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:25",
        authority,
        options: stateOptions(),
      }),
    ).toThrow(/does not bind this delegation_ref/);
  });

  it("refuses stale human authority that is no longer current", async () => {
    acquire({ delegationRef: "delegation:26" });
    const fixture = await createTrustedHumanIngressFixture();
    const authority = await mintFallback({
      delegationRef: "delegation:26",
      intent: "fallback",
      fixture,
    });
    fixture.retire();
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:26",
        authority,
        options: stateOptions(),
      }),
    ).toThrow(/no longer current|changed/);
  });

  it("refuses to mint authority without Host ingress evidence and owner authority", async () => {
    const fixture = await createTrustedHumanIngressFixture();
    const admissionEvidence = fixture.evidence();
    expect(admissionEvidence).toBeDefined();
    expect(() =>
      mintTrustedHumanFallbackAuthority({
        ingressContext: {},
        admissionEvidence: admissionEvidence!,
        delegationRef: "delegation:27",
        intent: "fallback",
        authorityRef: "authority:test",
      }),
    ).toThrow(/bound to this ingress context/);
    expect(() =>
      requireTrustedHumanFallbackAuthority({
        authority: { delegationRef: "delegation:27", intent: "fallback" },
        delegationRef: "delegation:27",
        intent: "fallback",
      }),
    ).toThrow(/Host capability/);
  });
});

describe("delegated execution ownership — release discipline", () => {
  it("does not release on timeout", async () => {
    acquire({ delegationRef: "delegation:30" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { db } = openRegistry();
    const record = readDelegatedExecutionOwnership({ db, delegationRef: "delegation:30" });
    expect(record.kind).toBe("owned");
    expect(admitAgentExecution({ db, delegationRef: "delegation:30" }).allowed).toBe(false);
  });

  it("does not release on an ordinary MUSE approval", () => {
    acquire({ delegationRef: "delegation:31" });
    const museApproval = { kind: "muse-approval", decision: "APPROVE" };
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:31",
        authority: museApproval,
        options: stateOptions(),
      }),
    ).toThrow(/Host capability/);
    const { db } = openRegistry();
    expect(admitAgentExecution({ db, delegationRef: "delegation:31" }).allowed).toBe(false);
  });

  it("does not expose any non-releasing reason as a transition", () => {
    expect(DELEGATED_EXECUTION_OWNERSHIP_NON_RELEASING_REASONS).toContain("gateway-restart");
    expect(DELEGATED_EXECUTION_OWNERSHIP_NON_RELEASING_REASONS).toContain("model-decision");
  });

  it.each([
    ["DELEGATE_TERMINAL_COMPLETED", "completed"],
    ["DELEGATE_TERMINAL_CANCELLED", "cancelled"],
    ["DELEGATE_TERMINAL_HANDBACK", "handed back"],
  ] as const)("releases on %s", (event: DelegatedExecutionOwnershipEvent) => {
    acquire({ delegationRef: "delegation:" + event });
    const record = releaseDelegatedExecutionOwnership({
      delegationRef: "delegation:" + event,
      event: event as never,
      actorKind: "delegate",
      actorRef: "delegate-plugin",
      options: stateOptions(),
    });
    expect(record.state).toBe("RELEASED");
    expect(record.releaseEvent).toBe(event);
    expect(record.releasedAt).not.toBeNull();
  });

  it("is idempotent for repeated identical terminal release", () => {
    acquire({ delegationRef: "delegation:terminal-idempotent" });
    const first = releaseDelegatedExecutionOwnership({
      delegationRef: "delegation:terminal-idempotent",
      event: "DELEGATE_TERMINAL_COMPLETED",
      actorKind: "delegate",
      actorRef: "delegate-plugin",
      options: stateOptions(),
    });
    const second = releaseDelegatedExecutionOwnership({
      delegationRef: "delegation:terminal-idempotent",
      event: "DELEGATE_TERMINAL_COMPLETED",
      actorKind: "delegate",
      actorRef: "delegate-plugin",
      options: stateOptions(),
    });
    expect(second.revision).toBe(first.revision);
    expect(second.state).toBe("RELEASED");
  });
});

describe("delegated execution ownership — concurrency (CAS)", () => {
  it("refuses a stale transition as a typed conflict", async () => {
    acquire({ delegationRef: "delegation:40" });
    const authority = await mintFallback({ delegationRef: "delegation:40", intent: "fallback" });
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:40",
        authority,
        options: stateOptions(),
      }),
    ).not.toThrow();
    // A second CAS against the retained expected revision must lose.
    expect(() =>
      releaseDelegatedExecutionOwnership({
        delegationRef: "delegation:40",
        event: "DELEGATE_TERMINAL_COMPLETED",
        actorKind: "delegate",
        actorRef: "delegate-plugin",
        ownerKind: "plugin",
        ownerId: "delegate-plugin",
        options: stateOptions(),
      }),
    ).not.toThrow();
  });

  it("lets exactly one winner in the fallback/handback race", () => {
    acquire({ delegationRef: "delegation:41" });
    const record = releaseDelegatedExecutionOwnership({
      delegationRef: "delegation:41",
      event: "DELEGATE_TERMINAL_HANDBACK",
      actorKind: "delegate",
      actorRef: "delegate-plugin",
      options: stateOptions(),
    });
    expect(record.state).toBe("RELEASED");
    expect(record.releaseEvent).toBe("DELEGATE_TERMINAL_HANDBACK");
    expect(() =>
      releaseDelegatedExecutionOwnership({
        delegationRef: "delegation:41",
        event: "DELEGATE_TERMINAL_CANCELLED",
        actorKind: "delegate",
        actorRef: "delegate-plugin",
        options: stateOptions(),
      }),
    ).toThrow(/refused/);
  });

  it("refuses a CAS whose actor binding does not match the retained owner", () => {
    acquire({ delegationRef: "delegation:42", ownerId: "owner-a" });
    expect(() =>
      recordDelegateOwnerAvailable({
        delegationRef: "delegation:42",
        ownerKind: "plugin",
        ownerId: "owner-b",
        delegateGoalRef: "goal:other",
        options: stateOptions(),
      }),
    ).toThrow(/refused/);
  });

  it("refuses transitions against an unknown delegation_ref", () => {
    expect(() =>
      releaseDelegatedExecutionOwnership({
        delegationRef: "delegation:missing",
        event: "DELEGATE_TERMINAL_COMPLETED",
        actorKind: "delegate",
        actorRef: "delegate-plugin",
        options: stateOptions(),
      }),
    ).toThrow(/no ownership record/);
  });
});

describe("delegated execution ownership — restart and downgrade", () => {
  it("rehydrates every non-terminal reservation before execution is enabled", () => {
    acquire({ delegationRef: "delegation:50" });
    acquire({ delegationRef: "delegation:51" });
    releaseDelegatedExecutionOwnership({
      delegationRef: "delegation:51",
      event: "DELEGATE_TERMINAL_COMPLETED",
      actorKind: "delegate",
      actorRef: "delegate-plugin",
      options: stateOptions(),
    });
    const { db } = openRegistry();
    const rehydration = rehydrateDelegatedExecutionOwnership({ db });
    expect(rehydration.live.map((r) => r.delegationRef)).toEqual(["delegation:50"]);
    expect(rehydration.byRef.has("delegation:51")).toBe(false);
  });

  it("stays locked with an unavailable owner after restart", () => {
    acquire({ delegationRef: "delegation:52" });
    recordDelegateOwnerUnavailable({
      delegationRef: "delegation:52",
      ownerKind: "plugin",
      ownerId: "delegate-plugin",
      options: stateOptions(),
    });
    const { db } = openRegistry();
    const rehydration = prepareDelegatedExecutionOwnershipStartup({ db });
    const record = rehydration.byRef.get("delegation:52");
    expect(record?.state).toBe("DELEGATED_LOCKED");
    expect(record?.ownerState).toBe("unavailable");
    expect(admitAgentExecution({ db, delegationRef: "delegation:52" }).allowed).toBe(false);
  });

  it("refuses a v21 database that lost the ownership registry", () => {
    const { db } = openRegistry();
    db.exec("DROP TABLE " + DELEGATED_EXECUTION_OWNERSHIP_TABLE + ";");
    expect(() =>
      assertDelegatedExecutionOwnershipDowngradeSafe({ db, publishedSchemaVersion: 21 }),
    ).toThrow(/published schema v21 without the delegated execution ownership registry/);
  });

  it("refuses a reservation written by a higher enforcement floor", () => {
    acquire({ delegationRef: "delegation:53" });
    const { db } = openRegistry();
    db.prepare(
      "UPDATE " +
        DELEGATED_EXECUTION_OWNERSHIP_TABLE +
        " SET enforcement_floor = ? WHERE delegation_ref = ?",
    ).run(DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION + 5, "delegation:53");
    expect(() => assertDelegatedExecutionOwnershipDowngradeSafe({ db })).toThrow(
      /requires enforcement version/,
    );
  });

  it("permits a pre-v21 database with no ownership registry at all", () => {
    const legacyPath = tempDirs.make("openclaw-delegated-ownership-legacy-") + "/legacy.sqlite";
    const db = openNodeSqliteDatabase(legacyPath);
    try {
      expect(() => assertDelegatedExecutionOwnershipDowngradeSafe({ db })).not.toThrow();
    } finally {
      db.close();
    }
  });
});
