import { describe, expect, it } from "vitest";
import { createTestOperatorAuthority } from "../agents/admitted-run-context.test-support.js";
import { captureScheduledOperatorSource } from "../agents/operator-run-recovery-source.js";
import type { BoundParticipationCeiling } from "../agents/participation-ceiling.js";
import { createTestCronOperatorSource } from "../cron/execution-context.test-support.js";
import {
  decodeGatewayOperatorRecoverySource,
  decodeQueuedOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";

// Exact ordinary main dialect: no version or participation fields in the snapshot.
const ordinary = {
  profileId: "operator",
  scopes: ["operator.admin"],
  assignedRole: null,
  githubLogin: null,
  grant: null,
  aliasBindingIds: [],
  authPolicy: {
    generation: "" as const,
    grantGeneration: "generation",
    role: "operator" as const,
    authMethod: "token" as const,
  },
  controlUiAdmin: true,
  localOperator: true,
  sourceIngress: "control-ui" as const,
};
const ceiling: BoundParticipationCeiling = {
  kind: "send",
  profileId: "operator",
  sessionKey: "agent:main:invited",
  tools: ["read", "automations"],
  permission: "workspace",
  toolConstraints: [["read", "auto*"]],
  source: {
    agentId: "main",
    sessionId: "invited-session",
    lifecycleRevision: null,
    creatorProfileId: "creator",
    root: "/invited",
  },
};
const participant = () => ({
  ...ordinary,
  version: 2 as const,
  participationCeiling: structuredClone(ceiling),
});
const source = (snapshot: unknown) => ({
  version: 1,
  agentId: "main",
  sessionKey: "agent:main:invited",
  sourceRunId: "run",
  snapshot,
});

describe("shared operator recovery dialect", () => {
  it("round trips released ordinary bytes and preserves their exact size boundary", () => {
    expect(JSON.stringify(normalizeGatewayOperatorRecoverySnapshot(ordinary))).toBe(
      JSON.stringify(ordinary),
    );
    const queued = { kind: "gateway", snapshot: ordinary };
    expect(JSON.stringify(decodeQueuedOperatorRecoverySource(queued))).toBe(JSON.stringify(queued));
    expect(JSON.stringify(decodeGatewayOperatorRecoverySource(source(ordinary)))).toBe(
      JSON.stringify(source(ordinary)),
    );
    const exact = {
      ...ordinary,
      aliasBindingIds: Array.from({ length: 16 }, () => "x".repeat(4000)),
    };
    const remaining = 65_536 - Buffer.byteLength(JSON.stringify(exact)) - 3;
    exact.aliasBindingIds.push("y".repeat(remaining));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(65_536);
    expect(normalizeGatewayOperatorRecoverySnapshot(exact)).toEqual(exact);
    exact.aliasBindingIds[16] += "x";
    expect(normalizeGatewayOperatorRecoverySnapshot(exact)).toBeUndefined();
  });

  it("keeps the released cron source fixture byte-identical without an invitation", () => {
    const released = {
      executionRevision: "exec-1",
      source: {
        version: 1,
        agentId: "main",
        sessionKey: "agent:main:ordinary-baseline",
        sessionId: "parent-session",
        lifecycleRevision: "rev-1",
        sourceRunId: "source-run",
        snapshot: {
          profileId: "profile-1",
          scopes: ["operator.admin"],
          assignedRole: null,
          githubLogin: null,
          grant: null,
          aliasBindingIds: [],
          authPolicy: {
            generation: "",
            grantGeneration: "grant-gen",
            role: "operator",
            authMethod: "device-token",
          },
          device: {
            deviceId: "device-1",
            key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          controlUiAdmin: true,
          localOperator: false,
          sourceIngress: "control-ui",
        },
      },
    };
    const current = createTestCronOperatorSource("agent:main:ordinary-baseline");
    expect(JSON.stringify(current)).toBe(JSON.stringify(released));
    expect(JSON.stringify(decodeGatewayOperatorRecoverySource(released.source))).toBe(
      JSON.stringify(released.source),
    );
    expect(
      decodeQueuedOperatorRecoverySource({ kind: "gateway", snapshot: released.source.snapshot }),
    ).toEqual({ kind: "gateway", snapshot: released.source.snapshot });
  });

  it("retains bound invitation evidence in both durable carriers", () => {
    const snapshot = participant();
    const stored = JSON.stringify(source(snapshot));
    const reloaded: unknown = JSON.parse(stored);
    expect(decodeGatewayOperatorRecoverySource(reloaded)).toEqual(source(snapshot));
    expect(decodeQueuedOperatorRecoverySource({ kind: "gateway", snapshot })).toEqual({
      kind: "gateway",
      snapshot,
    });
  });

  it.each([
    { ...ordinary, version: 2 },
    { ...participant(), version: 3 },
    { ...participant(), profileId: "someone-else" },
    { ...participant(), participationCeiling: { ...ceiling, source: undefined } },
    { ...participant(), participationCeiling: { ...ceiling, permission: undefined } },
    { ...participant(), participationCeiling: { ...ceiling, tools: undefined } },
    {
      ...participant(),
      participationCeiling: {
        ...ceiling,
        source: { ...ceiling.source, lifecycleRevision: undefined },
      },
    },
    {
      ...participant(),
      participationCeiling: {
        ...ceiling,
        execPolicy: { security: "full", ask: "off", denyMisses: false },
      },
    },
    {
      ...participant(),
      participationCeiling: { ...ceiling, tools: Array.from({ length: 257 }, () => "read") },
    },
    { ...participant(), extra: true },
  ])("refuses malformed participant evidence %#", (snapshot) => {
    expect(() => decodeQueuedOperatorRecoverySource({ kind: "gateway", snapshot })).toThrow();
  });

  it("refuses an agent mismatch without retargeting the invitation", () => {
    expect(() =>
      decodeGatewayOperatorRecoverySource({ ...source(participant()), agentId: "other" }),
    ).toThrow();
  });

  it("never downgrades unavailable or oversized participant scheduling to source-less work", () => {
    for (const recoverySnapshot of [undefined, ordinary]) {
      const authority = createTestOperatorAuthority({
        canonicalIdentity: null,
        profileId: "operator",
        scopes: ["operator.admin"],
        recoverySnapshot,
        participationCeiling: { ...ceiling, tools: ["x".repeat(65_536)] },
      });
      expect(captureQueuedOperatorRecoverySource(authority)).toMatchObject({ kind: "unavailable" });
      expect(() =>
        captureScheduledOperatorSource({ authority, agentId: "main", sourceRunId: "run" }),
      ).toThrow(/retained/);
    }
    const authority = createTestOperatorAuthority({
      canonicalIdentity: null,
      profileId: "operator",
      scopes: ["operator.admin"],
    });
    expect(
      captureScheduledOperatorSource({ authority, agentId: "main", sourceRunId: "run" }),
    ).toBeUndefined();
  });
});
