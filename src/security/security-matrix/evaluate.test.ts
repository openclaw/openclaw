import { describe, expect, it } from "vitest";
import { evaluateSecurityMatrix, explainSecurityMatrixDecision } from "./evaluate.js";
import { createSecurityMatrixAuditEvent } from "./facts.js";
import { resolveSecurityMatrixCapabilityFromTool } from "./tool-capability.js";
import type {
  SecurityMatrixInfluenceSource,
  SecurityMatrixPolicy,
  SecurityMatrixToolCapability,
} from "./types.js";

const externalSources = [
  "web_fetch",
  "browser",
  "email",
  "file",
  "github",
  "webhook",
  "memory",
  "skill",
  "api",
  "channel_metadata",
  "unknown_external",
] as const satisfies readonly SecurityMatrixInfluenceSource[];

describe("Security Matrix evaluator", () => {
  it.each([
    "exec",
    "credential_access",
    "system_config",
  ] as const satisfies readonly SecurityMatrixToolCapability[])(
    "returns block for external influence over %s",
    (capability) => {
      for (const source of externalSources) {
        expect(
          evaluateSecurityMatrix({ actor: "agent", influencedBy: [source], capability }),
        ).toMatchObject({
          actor: "agent",
          source,
          influencedBy: [source],
          capability,
          policyDecision: "block",
          decision: "block",
          matched: "policy",
        });
      }
    },
  );

  it.each([
    "write_file",
    "git",
    "email_send",
    "calendar_write",
    "memory_write",
  ] as const satisfies readonly SecurityMatrixToolCapability[])(
    "returns require_confirm for external influence over %s",
    (capability) => {
      for (const source of externalSources) {
        expect(evaluateSecurityMatrix({ influencedBy: [source], capability })).toMatchObject({
          source,
          capability,
          policyDecision: "require_confirm",
          decision: "require_confirm",
          matched: "policy",
        });
      }
    },
  );

  it.each([
    "network",
    "read_file",
    "browser",
    "memory_read",
  ] as const satisfies readonly SecurityMatrixToolCapability[])(
    "returns warn for external influence over %s",
    (capability) => {
      for (const source of externalSources) {
        expect(evaluateSecurityMatrix({ influencedBy: [source], capability })).toMatchObject({
          source,
          capability,
          policyDecision: "warn",
          decision: "warn",
          matched: "policy",
        });
      }
    },
  );

  it("does not treat agent as a trust source when external content influenced the call", () => {
    expect(
      evaluateSecurityMatrix({ actor: "agent", influencedBy: ["web_fetch"], capability: "exec" }),
    ).toMatchObject({
      actor: "agent",
      source: "web_fetch",
      influencedBy: ["web_fetch"],
      policyDecision: "block",
      decision: "block",
    });
  });

  it("allows known capabilities when no external influence is present", () => {
    expect(evaluateSecurityMatrix({ actor: "user", capability: "exec" })).toMatchObject({
      actor: "user",
      source: "none",
      influencedBy: [],
      capability: "exec",
      policyDecision: "allow",
      decision: "allow",
    });
  });

  it("keeps source shorthand compatibility while ignoring actor-like sources", () => {
    expect(evaluateSecurityMatrix({ source: "agent", capability: "exec" })).toMatchObject({
      actor: "agent",
      source: "none",
      influencedBy: [],
      decision: "allow",
    });
  });

  it("normalizes unknown external sources to unknown_external", () => {
    const evaluation = evaluateSecurityMatrix({ source: "feed_reader", capability: "exec" });

    expect(evaluation).toMatchObject({
      source: "unknown_external",
      originalSource: "feed_reader",
      influencedBy: ["unknown_external"],
      capability: "exec",
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });
  });

  it("normalizes unknown capabilities to unknown", () => {
    const evaluation = evaluateSecurityMatrix({ influencedBy: ["email"], capability: "new_tool" });

    expect(evaluation).toMatchObject({
      source: "email",
      capability: "unknown",
      originalCapability: "new_tool",
      policyDecision: "require_confirm",
      decision: "require_confirm",
      matched: "policy",
    });
  });

  it("uses the strictest decision when multiple sources influenced a call", () => {
    expect(
      evaluateSecurityMatrix({ influencedBy: ["browser", "github"], capability: "git" }),
    ).toMatchObject({
      source: "browser",
      influencedBy: ["browser", "github"],
      policyDecision: "require_confirm",
      decision: "require_confirm",
    });

    expect(
      evaluateSecurityMatrix({ influencedBy: ["browser", "email"], capability: "exec" }),
    ).toMatchObject({
      policyDecision: "block",
      decision: "block",
    });
  });

  it("allows approval to satisfy require_confirm without overriding block", () => {
    expect(
      evaluateSecurityMatrix({
        influencedBy: ["email"],
        capability: "write_file",
        approvalState: "approved",
      }),
    ).toMatchObject({
      policyDecision: "require_confirm",
      decision: "allow",
      matched: "approval_state",
    });

    expect(
      evaluateSecurityMatrix({
        influencedBy: ["email"],
        capability: "exec",
        approvalState: "approved",
      }),
    ).toMatchObject({
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });
  });

  it("lets existing operator policy deny any matrix decision", () => {
    expect(
      evaluateSecurityMatrix({ actor: "user", capability: "read_file", operatorPolicy: "denied" }),
    ).toMatchObject({
      policyDecision: "allow",
      decision: "block",
      matched: "operator_policy",
    });
  });

  it("does not allow a custom policy to weaken defaults unless explicitly enabled", () => {
    const policy = {
      web_fetch: {
        exec: {
          decision: "allow",
          reason: "Test policy override.",
        },
      },
    } satisfies SecurityMatrixPolicy;

    expect(
      evaluateSecurityMatrix({ influencedBy: ["web_fetch"], capability: "exec", policy }),
    ).toMatchObject({
      source: "web_fetch",
      capability: "exec",
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });

    expect(
      evaluateSecurityMatrix({
        influencedBy: ["web_fetch"],
        capability: "exec",
        policy,
        allowPolicyWeakening: true,
      }),
    ).toMatchObject({
      source: "web_fetch",
      capability: "exec",
      policyDecision: "allow",
      decision: "allow",
      matched: "policy",
    });
  });

  it.each([
    [
      "object",
      {
        web_fetch: {
          exec: {
            decision: "permit",
            reason: "Invalid external policy override.",
          },
        },
      },
    ],
    [
      "string",
      {
        web_fetch: {
          exec: "permit",
        },
      },
    ],
  ])("ignores malformed custom policy %s decisions", (_kind, policy) => {
    expect(
      evaluateSecurityMatrix({
        influencedBy: ["web_fetch"],
        capability: "exec",
        policy: policy as unknown as SecurityMatrixPolicy,
        allowPolicyWeakening: true,
      }),
    ).toMatchObject({
      source: "web_fetch",
      capability: "exec",
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });
  });

  it("keeps default policy rules when a partial custom policy has no matching rule", () => {
    const policy = {
      web_fetch: {
        read_file: "warn",
      },
    } satisfies SecurityMatrixPolicy;

    expect(
      evaluateSecurityMatrix({
        influencedBy: ["web_fetch"],
        capability: "credential_access",
        policy,
      }),
    ).toMatchObject({
      source: "web_fetch",
      capability: "credential_access",
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });
  });

  it("maps concrete tool names into capabilities", () => {
    expect(resolveSecurityMatrixCapabilityFromTool("exec")).toBe("exec");
    expect(resolveSecurityMatrixCapabilityFromTool("gmail.send")).toBe("email_send");
    expect(resolveSecurityMatrixCapabilityFromTool("workspace.apply_patch")).toBe("write_file");
    expect(resolveSecurityMatrixCapabilityFromTool("custom.opaque.tool")).toBe("unknown");
  });

  it("creates audit events from runtime tool facts", () => {
    const event = createSecurityMatrixAuditEvent({
      toolName: "exec",
      toolSource: "core",
      actor: "agent",
      influencedBy: ["github"],
      approvalState: "none",
      operatorPolicy: "allowed",
    });

    expect(event).toMatchObject({
      type: "security_matrix.evaluated",
      toolName: "exec",
      toolSource: "core",
      actor: "agent",
      influencedBy: ["github"],
      capability: "exec",
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });
  });

  it("explains the actor, influence, capability, decision, and match state", () => {
    const explanation = explainSecurityMatrixDecision(
      evaluateSecurityMatrix({ actor: "agent", influencedBy: ["web_fetch"], capability: "exec" }),
    );

    expect(explanation).toContain("agent influencedBy=web_fetch -> exec");
    expect(explanation).toContain("policyDecision=block");
    expect(explanation).toContain("decision=block");
    expect(explanation).toContain("matched=policy");
  });
});
