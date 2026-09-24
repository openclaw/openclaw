// Cross-language fixture pins the authority handoff shared with the Rust node runtime.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../gateway/node-command-policy.js";
import { normalizeNodeApprovalSurfaceList } from "./node-pairing-surface.js";

type AuthorityState = "invocable" | "pending-approval" | "undeclared" | "unauthorized";

type AuthoritySnapshot = {
  name: string;
  connectionId: string;
  pairingGeneration: string;
  sessionActive: boolean;
  declaredCommands: string[];
  approvedCommands: string[];
  effectiveCommands: string[];
  withheldCommands: string[];
  gatewayPolicy: {
    allow: string[];
    deny: string[];
  };
  expectedStates: Array<{ command: string; state: AuthorityState }>;
};

type IntegrationFixture = {
  version: number;
  declaredCapabilities: string[];
  expectedCapabilities: string[];
  declaredCommands: string[];
  expectedCommands: string[];
  authoritySnapshots: AuthoritySnapshot[];
  authorityTransitions: Array<{
    name: string;
    from: string;
    to: string;
    command: string;
    fromState: AuthorityState;
    toState: AuthorityState;
    preservesConnection: boolean;
    cancelsActive: boolean;
    retiresPairingGeneration: boolean;
  }>;
  invocations: Array<{
    snapshot: string;
    command: string;
    gatewayState: AuthorityState;
    gatewayDelivery: "deliver" | "reject";
    localAdmission: "allow" | "deny" | "not-evaluated";
    expected?: "success" | "failure";
    errorCode?: string;
    errorMessage?: string;
  }>;
  cleanup: Array<{
    trigger: string;
    owner: "gateway" | "node-runtime";
    effects: string[];
  }>;
};

function loadFixture(): IntegrationFixture {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "node-runtime-integration-contract.json",
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as IntegrationFixture;
}

function resolveAuthority(snapshot: AuthoritySnapshot, command: string): AuthorityState {
  const allowlist = resolveNodeCommandAllowlist({
    gateway: { nodes: { commands: snapshot.gatewayPolicy } },
  });
  const authority = resolveRequiredNodeCommandAuthority({
    requiredCommands: [command],
    declaredCommands: snapshot.declaredCommands,
    effectiveCommands: snapshot.effectiveCommands,
    withheldCommands: snapshot.withheldCommands,
    allowlist,
  });
  expect(authority?.command).toBe(command);
  return authority?.state ?? "undeclared";
}

describe("node runtime integration contract", () => {
  const fixture = loadFixture();
  const snapshots = new Map(
    fixture.authoritySnapshots.map((snapshot) => [snapshot.name, snapshot]),
  );

  it("normalizes deterministic connection manifests", () => {
    expect(fixture.version).toBe(3);
    expect(
      [...new Set(normalizeNodeApprovalSurfaceList(fixture.declaredCapabilities))].toSorted(),
    ).toEqual(fixture.expectedCapabilities);
    expect(
      [...new Set(normalizeNodeApprovalSurfaceList(fixture.declaredCommands))].toSorted(),
    ).toEqual(fixture.expectedCommands);
  });

  it("matches current Gateway authority states and transitions", () => {
    for (const snapshot of fixture.authoritySnapshots) {
      expect(snapshot.sessionActive).toBe(true);
      expect(
        snapshot.effectiveCommands.every((command) => snapshot.approvedCommands.includes(command)),
      ).toBe(true);
      expect(
        snapshot.approvedCommands.every((command) => snapshot.declaredCommands.includes(command)),
      ).toBe(true);
      for (const expected of snapshot.expectedStates) {
        expect(resolveAuthority(snapshot, expected.command)).toBe(expected.state);
      }
    }

    for (const transition of fixture.authorityTransitions) {
      const from = snapshots.get(transition.from);
      const to = snapshots.get(transition.to);
      expect(from, `${transition.name} source snapshot`).toBeDefined();
      expect(to, `${transition.name} destination snapshot`).toBeDefined();
      expect(resolveAuthority(from!, transition.command)).toBe(transition.fromState);
      expect(resolveAuthority(to!, transition.command)).toBe(transition.toState);
      expect(from!.connectionId === to!.connectionId).toBe(transition.preservesConnection);
      expect(from!.pairingGeneration !== to!.pairingGeneration).toBe(
        transition.retiresPairingGeneration,
      );
    }
  });

  it("keeps Gateway authority ahead of fail-closed local admission", () => {
    for (const invocation of fixture.invocations) {
      const snapshot = snapshots.get(invocation.snapshot);
      expect(snapshot, `${invocation.command} authority snapshot`).toBeDefined();
      expect(resolveAuthority(snapshot!, invocation.command)).toBe(invocation.gatewayState);
      expect(invocation.gatewayDelivery).toBe(
        invocation.gatewayState === "invocable" ? "deliver" : "reject",
      );
      if (invocation.gatewayDelivery === "reject") {
        expect(invocation.localAdmission).toBe("not-evaluated");
      }
    }
  });

  it("assigns complete cleanup to the owning layer", () => {
    const expectedEffects = [
      "cancel-handler",
      "close-input",
      "reject-progress",
      "remove-active-invocation",
    ];
    expect(fixture.cleanup.map((entry) => entry.trigger).toSorted()).toEqual([
      "deadline",
      "node.invoke.cancel",
      "pairing-generation-change",
      "policy-revocation",
    ]);
    for (const cleanup of fixture.cleanup) {
      expect(cleanup.effects.toSorted()).toEqual(expectedEffects);
    }
  });
});
