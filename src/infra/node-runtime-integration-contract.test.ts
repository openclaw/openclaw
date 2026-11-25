// Cross-language fixture pins the authority handoff shared with the Rust node runtime.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type fixtureData from "../../test/fixtures/node-runtime-integration-contract.json";
import {
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../gateway/node-command-policy.js";
import { normalizeNodeApprovalSurfaceList } from "./node-pairing-surface.js";

const fixture: typeof fixtureData = JSON.parse(
  fs.readFileSync(
    new URL("../../test/fixtures/node-runtime-integration-contract.json", import.meta.url),
    "utf8",
  ),
);

function resolveAuthority(snapshot: (typeof fixture.authoritySnapshots)[number], command: string) {
  const allowlist = resolveNodeCommandAllowlist({
    gateway: { nodes: { commands: snapshot.gatewayPolicy } },
  });
  const authority = resolveRequiredNodeCommandAuthority({
    nodeId: "integration-node",
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
  it("normalizes deterministic connection manifests", () => {
    expect(fixture.version).toBe(3);
    expect(
      [...new Set(normalizeNodeApprovalSurfaceList(fixture.declaredCapabilities))].toSorted(),
    ).toEqual(fixture.expectedCapabilities);
    expect(
      [...new Set(normalizeNodeApprovalSurfaceList(fixture.declaredCommands))].toSorted(),
    ).toEqual(fixture.expectedCommands);
  });

  it("matches current Gateway authority states", () => {
    for (const snapshot of fixture.authoritySnapshots) {
      for (const expected of snapshot.expectedStates) {
        expect(resolveAuthority(snapshot, expected.command)).toBe(expected.state);
      }
    }
  });
});
