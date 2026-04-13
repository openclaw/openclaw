import { describe, expect, it } from "vitest";
import { validateNexusTaskPacket } from "./nexus-task-packet.js";

const validPacket = `
packet_id: NX-2026-04-12-001
title: Validate one bounded lane
status: OPEN
lane: feat/example
authority_level: L1
approver_id: andy
approver_display_name: Andy
objective: Validate packet shape before runtime execution.
inputs:
  - docs/contracts/task-packet.md
source_of_truth_refs:
  - docs/contracts/task-packet.md
source_of_truth_verified_at: 2026-04-12T23:00:00Z
assumptions:
  - Repo truth is current.
constraints:
  - No execution in this lane.
expected_output:
  artifacts:
    - state/example.md
  test_coverage: N/A
  evidence_bundle:
    - review_notes
  review_gate_ref: RG-NX-2026-04-12-001
  operator_readable: true
validation_method: focused packet validation
escalation_triggers:
  - Missing approver
stop_conditions:
  - Packet validation fails
owner_id: openclaw
owner_display_name: OpenClaw
created_at: 2026-04-12T23:00:00Z
packet_verified_at: 2026-04-12T23:00:00Z
provenance:
  created_by_id: andy
`;

describe("validateNexusTaskPacket", () => {
  it("accepts a packet with required fields", () => {
    const packet = validateNexusTaskPacket(validPacket);
    expect(packet.packet_id).toBe("NX-2026-04-12-001");
    expect(packet.authority_level).toBe("L1");
    expect(packet.source_of_truth_refs).toEqual(["docs/contracts/task-packet.md"]);
    expect(packet.stop_conditions).toEqual(["Packet validation fails"]);
  });

  it("fails closed when authority level is missing", () => {
    const invalidPacket = validPacket.replace("authority_level: L1\n", "");
    expect(() => validateNexusTaskPacket(invalidPacket)).toThrow();
  });

  it("fails closed when source refs are missing", () => {
    const invalidPacket = validPacket.replace(
      /source_of_truth_refs:[\s\S]*?source_of_truth_verified_at: 2026-04-12T23:00:00Z\n/u,
      "source_of_truth_verified_at: 2026-04-12T23:00:00Z\n",
    );
    expect(() => validateNexusTaskPacket(invalidPacket)).toThrow();
  });

  it("fails closed when stop conditions are missing", () => {
    const invalidPacket = validPacket.replace(
      /stop_conditions:[\s\S]*?owner_id: openclaw\n/u,
      "owner_id: openclaw\n",
    );
    expect(() => validateNexusTaskPacket(invalidPacket)).toThrow();
  });
});
