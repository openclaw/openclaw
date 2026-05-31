import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  AGENT_OS_SCHEMA_VERSIONS,
  normalizeAgentOsArtifactContract,
  normalizeAgentOsCapabilityManifest,
  normalizeAgentOsProofEvent,
  normalizeAgentOsTicket,
  normalizeAgentOsTicketStatus,
  validateAgentOsArtifactContract,
  validateAgentOsCapabilityManifest,
  validateAgentOsProofEvent,
  validateAgentOsTicket,
} = require("../../scripts/lib/agent-os-contracts.cjs") as {
  AGENT_OS_SCHEMA_VERSIONS: Record<string, string>;
  normalizeAgentOsArtifactContract: (input: unknown) => Record<string, unknown>;
  normalizeAgentOsCapabilityManifest: (input: unknown) => {
    capabilityFamilies: string[];
    proof: { required: boolean };
    runtime: string;
    schemaVersion: string;
    sandbox: { filesystem: string; mode: string; network: string; secrets: string };
    ticketTypes: string[];
  };
  normalizeAgentOsProofEvent: (input: unknown) => {
    artifactRefs: Array<{ path: string }>;
    component: string;
    eventType: string;
    schemaVersion: string;
    status: string;
  };
  normalizeAgentOsTicket: (input: unknown) => {
    id: string;
    input: Record<string, unknown>;
    schemaVersion: string;
    status: string;
    targetAgent: string;
    type: string;
  };
  normalizeAgentOsTicketStatus: (status: string) => string;
  validateAgentOsArtifactContract: (input: unknown) => { errors: string[]; ok: boolean };
  validateAgentOsCapabilityManifest: (input: unknown) => { errors: string[]; ok: boolean };
  validateAgentOsProofEvent: (input: unknown) => { errors: string[]; ok: boolean };
  validateAgentOsTicket: (input: unknown) => { errors: string[]; ok: boolean };
};

describe("agent OS contracts", () => {
  it("normalizes ticket records into the versioned ticket contract", () => {
    const ticket = normalizeAgentOsTicket({
      data: JSON.stringify({ input: { query: "agent OS" }, title: "Research task" }),
      id: "ticket-1",
      priority: "7",
      status: "running",
      target_agent: "research_agent",
      type: "web research",
    });

    expect(ticket).toMatchObject({
      id: "ticket-1",
      input: { query: "agent OS" },
      schemaVersion: AGENT_OS_SCHEMA_VERSIONS.ticket,
      status: "IN_PROGRESS",
      targetAgent: "research_agent",
      type: "web_research",
    });
    expect(validateAgentOsTicket(ticket)).toMatchObject({ ok: true });
    expect(normalizeAgentOsTicketStatus("running")).toBe("IN_PROGRESS");
  });

  it("normalizes native capability profiles into stable capability manifests", () => {
    const manifest = normalizeAgentOsCapabilityManifest({
      id: "research_agent",
      name: "Research Agent",
      params: {
        capabilityFamily: "research",
        ticketTypes: ["research", "citation_answer"],
      },
      sandbox: { filesystem: "read", mode: "workspace-read", network: "allowlist" },
      skills: ["semantic-code-retrieval"],
    });

    expect(manifest).toMatchObject({
      capabilityFamilies: ["research"],
      proof: { required: true },
      runtime: "native-openclaw",
      schemaVersion: AGENT_OS_SCHEMA_VERSIONS.capability,
      sandbox: {
        filesystem: "read",
        mode: "workspace-read",
        network: "allowlist",
        secrets: "named-refs-only",
      },
      ticketTypes: ["research", "citation_answer"],
    });
    expect(validateAgentOsCapabilityManifest(manifest)).toMatchObject({ ok: true });
  });

  it("normalizes proof events and artifact refs without losing legacy field names", () => {
    const event = normalizeAgentOsProofEvent({
      artifact_path: ".artifacts/ticket-1/report.md",
      component: "Signal Hub",
      event_type: "ticket.claimed",
      status: "pass",
    });

    expect(event).toMatchObject({
      artifactRefs: [{ path: ".artifacts/ticket-1/report.md" }],
      component: "signal_hub",
      eventType: "TICKET.CLAIMED",
      schemaVersion: AGENT_OS_SCHEMA_VERSIONS.proofEvent,
      status: "PASS",
    });
    expect(validateAgentOsProofEvent(event)).toMatchObject({ ok: true });
  });

  it("validates artifact contracts for proof-producing agents", () => {
    const artifact = normalizeAgentOsArtifactContract({
      createdBy: "research_agent",
      kind: "proof bundle",
      path: ".artifacts/capability-proofs/ticket-1/proof-events-bundle.json",
      ticketId: "ticket-1",
    });

    expect(artifact).toMatchObject({
      createdBy: "research_agent",
      kind: "proof_bundle",
      path: ".artifacts/capability-proofs/ticket-1/proof-events-bundle.json",
      schemaVersion: AGENT_OS_SCHEMA_VERSIONS.artifact,
      ticketId: "ticket-1",
      visibility: "local",
    });
    expect(validateAgentOsArtifactContract(artifact)).toMatchObject({ ok: true });
  });

  it("returns actionable validation errors for incomplete contracts", () => {
    expect(validateAgentOsTicket({ type: "research" })).toMatchObject({
      errors: ["ticket.id is required"],
      ok: false,
    });
    expect(validateAgentOsCapabilityManifest({ id: "empty" }).errors).toContain(
      "capability.ticketTypes must contain at least one ticket type",
    );
  });
});
