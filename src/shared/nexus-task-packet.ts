import YAML from "yaml";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const ExpectedOutputSchema = z
  .object({
    artifacts: z.array(nonEmptyString),
    test_coverage: nonEmptyString,
    evidence_bundle: z.array(nonEmptyString),
    review_gate_ref: nonEmptyString,
    operator_readable: z.boolean(),
  })
  .passthrough();

export const NexusTaskPacketSchema = z
  .object({
    packet_id: nonEmptyString,
    title: nonEmptyString,
    status: nonEmptyString,
    lane: nonEmptyString,
    authority_level: z.enum(["L0", "L1", "L2", "L3", "L4"]),
    approver_id: nonEmptyString,
    approver_display_name: nonEmptyString,
    objective: nonEmptyString,
    inputs: z.array(nonEmptyString).min(1),
    source_of_truth_refs: z.array(nonEmptyString).min(1),
    source_of_truth_verified_at: nonEmptyString,
    assumptions: z.array(nonEmptyString),
    constraints: z.array(nonEmptyString),
    expected_output: ExpectedOutputSchema,
    validation_method: nonEmptyString,
    escalation_triggers: z.array(nonEmptyString),
    stop_conditions: z.array(nonEmptyString).min(1),
    owner_id: nonEmptyString,
    owner_display_name: nonEmptyString,
    created_at: nonEmptyString,
    packet_verified_at: nonEmptyString,
    provenance: z
      .object({
        created_by_id: nonEmptyString,
      })
      .passthrough(),
  })
  .passthrough();

export type NexusTaskPacket = z.infer<typeof NexusTaskPacketSchema>;

export function parseNexusTaskPacketDocument(input: string): unknown {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  return YAML.parse(trimmed);
}

export function validateNexusTaskPacket(input: string | Record<string, unknown>): NexusTaskPacket {
  const parsed = typeof input === "string" ? parseNexusTaskPacketDocument(input) : input;
  return NexusTaskPacketSchema.parse(parsed);
}
