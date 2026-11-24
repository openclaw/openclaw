import { expect, it } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { importLegacyCronMemberSources } from "../../cron/store/member-source-role-import.js";
import { makeCronStreamSandboxTarget } from "../../cron/stream-sandbox.test-support.js";
import type { QueuedOperatorRecoverySource } from "../operator-run-recovery-source.codec.js";
import {
  importLegacyMemberQueuedSource,
  importLegacyMemberSnapshot,
} from "./member-source-role-import.js";
import {
  legacyMemberSnapshot,
  memberRoleImport,
} from "./member-source-role-import.test-support.js";

it("imports only the role representation, retaining every captured grant and the queued envelope", () => {
  const snapshot = legacyMemberSnapshot();
  const next = importLegacyMemberSnapshot(snapshot, memberRoleImport);
  expect(next).toEqual({ ...snapshot, assignedRole: "operator" });
  expect(next.modelPolicy).toBe(snapshot.modelPolicy);
  expect(next.openclawIdPrincipal).toBe(snapshot.openclawIdPrincipal);
  expect(importLegacyMemberSnapshot(next, memberRoleImport)).toBe(next);
  const queued: QueuedOperatorRecoverySource = { kind: "gateway", snapshot };
  expect(importLegacyMemberQueuedSource(queued, memberRoleImport)).toEqual({
    ...queued,
    snapshot: next,
  });
});

it("does not turn a profile import into reauthorization of mismatched or broader captures", () => {
  const snapshot = legacyMemberSnapshot();
  for (const candidate of [
    { ...snapshot, profileId: "other" },
    { ...snapshot, assignedRole: "operator" },
    { ...snapshot, scopes: ["operator.admin"] },
    { ...snapshot, rolePolicy: undefined },
    { ...snapshot, rolePolicy: { ...memberRoleImport.policy, agents: "*" as const } },
    { ...snapshot, rolePolicy: { ...memberRoleImport.policy, scopes: ["operator.read" as const] } },
    { ...snapshot, openclawIdPrincipal: undefined },
    {
      ...snapshot,
      openclawIdPrincipal: { ...snapshot.openclawIdPrincipal!, kind: "owner" as const },
    },
  ]) {
    expect(importLegacyMemberSnapshot(candidate, memberRoleImport)).toBe(candidate);
  }
  for (const input of [
    { ...memberRoleImport, accountId: "other" },
    { ...memberRoleImport, role: "viewer" },
    { ...memberRoleImport, policy: { ...memberRoleImport.policy, scopes: [] } },
  ]) {
    expect(importLegacyMemberSnapshot(snapshot, input)).toBe(snapshot);
  }
  const channel: QueuedOperatorRecoverySource = {
    kind: "channel",
    snapshot: {
      profileId: memberRoleImport.profileId,
      scopes: ["operator.read"],
      reference: { version: 1, id: "bb04b15e-f0d7-4f15-9bee-856183ddcb2e" },
    },
  };
  expect(importLegacyMemberQueuedSource(channel, memberRoleImport)).toBe(channel);
  const unavailable: QueuedOperatorRecoverySource = { kind: "unavailable", reason: "no-source" };
  expect(importLegacyMemberQueuedSource(unavailable, memberRoleImport)).toBe(unavailable);
});

it("does not rewrite sandbox targets with different subjects, explicit assignments or broader scopes", () => {
  const snapshot = legacyMemberSnapshot();
  const operator = {
    profileId: snapshot.profileId,
    openclawIdPrincipal: snapshot.openclawIdPrincipal,
    scopes: snapshot.scopes,
    assignedRole: null,
    githubLogin: null,
    gatewayAccessGrant: snapshot.grant,
  };
  for (const patch of [
    { profileId: "other" },
    { assignedRole: "viewer" },
    { scopes: ["operator.admin"] },
    { openclawIdPrincipal: undefined },
  ]) {
    const job = {
      ...makeCronJob({ schedule: { kind: "stream", command: ["watch-source"] } }),
      streamSandbox: makeCronStreamSandboxTarget({ operator: { ...operator, ...patch } }),
    };
    expect(importLegacyCronMemberSources(job, memberRoleImport)).toBe(job);
  }
});
