/**
 * Host Guard B4 — trusted-human fallback/revoke authority bound to real ingress
 * evidence.
 *
 * Authority must derive from a Host ingress context that carries both an opaque
 * ChannelAdmissionEvidence bound to that exact context and a live
 * CommandOwnerAuthority. Caller-supplied strings, structurally identical
 * objects, missing evidence, missing authority, wrong delegation_ref, wrong
 * intent, and stale authority are all refusals.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import {
  consumeChannelAdmissionEvidence,
  type ChannelAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { admitAgentExecution } from "./delegated-execution-ownership-guard.js";
import {
  acquireDelegatedExecutionOwnership,
  authorizeTrustedHumanFallback,
  revokeDelegatedExecutionOwnership,
} from "./delegated-execution-ownership.js";
import {
  mintTrustedHumanFallbackAuthority,
  requireTrustedHumanFallbackAuthority,
} from "./trusted-human-fallback-authority.js";
import { createTrustedHumanIngressFixture } from "./trusted-human-fallback-authority.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let stateEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  stateEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-trusted-human-b4-") };
});

afterEach(() => closeOpenClawStateDatabaseForTest());

function stateOptions() {
  return { env: stateEnv };
}

function acquire(delegationRef: string) {
  return acquireDelegatedExecutionOwnership({
    delegationRef,
    ownerKind: "plugin",
    ownerId: "delegate-plugin",
    taskScopeRef: "task:" + delegationRef,
    lineageRef: "lineage:" + delegationRef,
    options: stateOptions(),
  });
}

function openRegistry(): { db: DatabaseSync } {
  return { db: openOpenClawStateDatabase(stateOptions()).db };
}

type Fixture = Awaited<ReturnType<typeof createTrustedHumanIngressFixture>>;

function evidenceOf(fixture: Fixture): ChannelAdmissionEvidence {
  const evidence = fixture.evidence();
  if (!evidence) {
    throw new Error("fixture did not bind channel admission evidence");
  }
  return evidence;
}

function mintFrom(
  fixture: Fixture,
  params: { delegationRef: string; intent: "fallback" | "revoke" },
) {
  return mintTrustedHumanFallbackAuthority({
    ingressContext: fixture.context,
    admissionEvidence: evidenceOf(fixture),
    delegationRef: params.delegationRef,
    intent: params.intent,
    authorityRef: "authority:test",
  });
}

describe("trusted-human fallback authority — ingress evidence binding", () => {
  it("TEST 1: mints and accepts fallback for exact evidence, live owner authority, and delegation_ref", async () => {
    acquire("delegation:b4-1");
    const fixture = await createTrustedHumanIngressFixture();
    const authority = mintFrom(fixture, { delegationRef: "delegation:b4-1", intent: "fallback" });
    const record = authorizeTrustedHumanFallback({
      delegationRef: "delegation:b4-1",
      authority,
      options: stateOptions(),
    });
    expect(record.state).toBe("FALLBACK_AUTHORIZED");
    const { db } = openRegistry();
    expect(
      admitAgentExecution({ db, delegationRef: "delegation:b4-1", fallbackAuthority: authority }),
    ).toEqual({ allowed: true, reason: "human-fallback-authorized" });
  });

  it("TEST 2: mints and accepts revoke for exact evidence, live owner authority, and delegation_ref", async () => {
    acquire("delegation:b4-2");
    const fixture = await createTrustedHumanIngressFixture();
    const authority = mintFrom(fixture, { delegationRef: "delegation:b4-2", intent: "revoke" });
    const record = revokeDelegatedExecutionOwnership({
      delegationRef: "delegation:b4-2",
      authority,
      options: stateOptions(),
    });
    expect(record.state).toBe("RELEASED");
    const { db } = openRegistry();
    expect(admitAgentExecution({ db, delegationRef: "delegation:b4-2" }).allowed).toBe(true);
  });

  it("TEST 3: refuses caller-supplied ingressRef/ownerRef strings with no evidence", async () => {
    const context: Record<string, unknown> = { ingressRef: "channel:test", ownerRef: "owner:test" };
    bindCommandOwnerAuthority(context, { isCurrent: () => true });
    expect(() =>
      mintTrustedHumanFallbackAuthority({
        ingressContext: context,
        admissionEvidence: { kind: "channel-admission-evidence" } as ChannelAdmissionEvidence,
        delegationRef: "delegation:b4-3",
        intent: "fallback",
        authorityRef: "authority:test",
      }),
    ).toThrow(/bound to this ingress context/);
  });

  it("TEST 4: refuses to mint when evidence is present but no live owner authority exists", async () => {
    const fixture = await createTrustedHumanIngressFixture({ ownerAllowFrom: [] });
    expect(fixture.evidence()).toBeDefined();
    expect(() =>
      mintFrom(fixture, { delegationRef: "delegation:b4-4", intent: "fallback" }),
    ).toThrow(/live Host command-owner authority/);
  });

  it("TEST 5: refuses to mint when live owner authority is present but admission evidence is missing", async () => {
    const fixture = await createTrustedHumanIngressFixture({ auditEnabled: false });
    expect(fixture.evidence()).toBeUndefined();
    expect(() =>
      mintTrustedHumanFallbackAuthority({
        ingressContext: fixture.context,
        admissionEvidence: { kind: "channel-admission-evidence" } as ChannelAdmissionEvidence,
        delegationRef: "delegation:b4-5",
        intent: "fallback",
        authorityRef: "authority:test",
      }),
    ).toThrow(/bound to this ingress context/);
  });

  it("TEST 6: refuses evidence belonging to a different ingress binding", async () => {
    const ownerA = await createTrustedHumanIngressFixture({ senderId: "owner-a" });
    const ownerB = await createTrustedHumanIngressFixture({ senderId: "owner-b" });
    const evidenceB = ownerB.evidence();
    expect(evidenceB).toBeDefined();
    // Owner B's context may not mint owner A's evidence, and vice versa.
    expect(() =>
      mintTrustedHumanFallbackAuthority({
        ingressContext: ownerB.context,
        admissionEvidence: evidenceOf(ownerA),
        delegationRef: "delegation:b4-6",
        intent: "fallback",
        authorityRef: "authority:test",
      }),
    ).toThrow(/bound to this ingress context/);
    expect(() =>
      mintTrustedHumanFallbackAuthority({
        ingressContext: ownerA.context,
        admissionEvidence: evidenceB!,
        delegationRef: "delegation:b4-6",
        intent: "fallback",
        authorityRef: "authority:test",
      }),
    ).toThrow(/bound to this ingress context/);
  });

  it("TEST 7: refuses to use live authority bound to a different delegation_ref", async () => {
    const fixture = await createTrustedHumanIngressFixture();
    const authority = mintFrom(fixture, { delegationRef: "delegation:b4-7a", intent: "fallback" });
    expect(() =>
      requireTrustedHumanFallbackAuthority({
        authority,
        delegationRef: "delegation:b4-7b",
        intent: "fallback",
      }),
    ).toThrow(/does not bind this delegation_ref/);
    acquire("delegation:b4-7b");
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:b4-7b",
        authority,
        options: stateOptions(),
      }),
    ).toThrow(/does not bind this delegation_ref/);
  });

  it("TEST 8: refuses to use live authority for a different intent", async () => {
    acquire("delegation:b4-8");
    const fixture = await createTrustedHumanIngressFixture();
    const fallbackOnly = mintFrom(fixture, {
      delegationRef: "delegation:b4-8",
      intent: "fallback",
    });
    expect(() =>
      requireTrustedHumanFallbackAuthority({
        authority: fallbackOnly,
        delegationRef: "delegation:b4-8",
        intent: "revoke",
      }),
    ).toThrow(/does not grant this intent/);
    expect(() =>
      revokeDelegatedExecutionOwnership({
        delegationRef: "delegation:b4-8",
        authority: fallbackOnly,
        options: stateOptions(),
      }),
    ).toThrow(/does not grant this intent/);
  });

  it("TEST 9: refuses later fallback and revoke use once authority is stale", async () => {
    acquire("delegation:b4-9a");
    const retired = await createTrustedHumanIngressFixture();
    const staleOwner = mintFrom(retired, { delegationRef: "delegation:b4-9a", intent: "fallback" });
    retired.retire();
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:b4-9a",
        authority: staleOwner,
        options: stateOptions(),
      }),
    ).toThrow(/no longer current|changed/);

    acquire("delegation:b4-9b");
    const consumed = await createTrustedHumanIngressFixture();
    const staleEvidence = mintFrom(consumed, {
      delegationRef: "delegation:b4-9b",
      intent: "revoke",
    });
    // Consuming the exact evidence the authority was minted from also stales it.
    consumeChannelAdmissionEvidence(evidenceOf(consumed));
    expect(() =>
      revokeDelegatedExecutionOwnership({
        delegationRef: "delegation:b4-9b",
        authority: staleEvidence,
        options: stateOptions(),
      }),
    ).toThrow(/no longer current|changed/);
  });

  it("TEST 10: refuses model/plugin/tool-supplied structurally identical objects", async () => {
    const fixture = await createTrustedHumanIngressFixture();
    // A copy of the real evidence loses the private carrier and cannot satisfy mint.
    const copiedEvidence = { ...(evidenceOf(fixture) as object) } as ChannelAdmissionEvidence;
    expect(() =>
      mintTrustedHumanFallbackAuthority({
        ingressContext: fixture.context,
        admissionEvidence: copiedEvidence,
        delegationRef: "delegation:b4-10",
        intent: "fallback",
        authorityRef: "authority:test",
      }),
    ).toThrow(/bound to this ingress context/);
    // A structurally identical fake authority object cannot be consumed as a capability.
    const forged = {
      delegationRef: "delegation:b4-10",
      intent: "fallback",
      authorityRef: "forged",
      assertCurrent: () => undefined,
    };
    expect(() =>
      requireTrustedHumanFallbackAuthority({
        authority: forged,
        delegationRef: "delegation:b4-10",
        intent: "fallback",
      }),
    ).toThrow(/Host capability/);
    expect(() =>
      authorizeTrustedHumanFallback({
        delegationRef: "delegation:b4-10",
        authority: forged,
        options: stateOptions(),
      }),
    ).toThrow(/Host capability/);
  });
});
