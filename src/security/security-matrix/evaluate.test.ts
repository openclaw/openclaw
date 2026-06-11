import { describe, expect, it } from "vitest";
import { evaluateSecurityMatrix, explainSecurityMatrixDecision } from "./evaluate.js";
import type {
  SecurityMatrixPolicy,
  SecurityMatrixToolCapability,
  SecurityMatrixTrustSource,
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
  "unknown_external",
] as const satisfies readonly SecurityMatrixTrustSource[];

describe("Security Matrix evaluator", () => {
  it.each([
    "exec",
    "credential_access",
    "system_config",
  ] as const satisfies readonly SecurityMatrixToolCapability[])(
    "returns block for external sources influencing %s",
    (capability) => {
      for (const source of externalSources) {
        expect(evaluateSecurityMatrix({ source, capability })).toMatchObject({
          source,
          capability,
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
    "returns require_confirm for external sources influencing %s",
    (capability) => {
      for (const source of externalSources) {
        expect(evaluateSecurityMatrix({ source, capability })).toMatchObject({
          source,
          capability,
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
    "returns warn for external sources influencing %s",
    (capability) => {
      for (const source of externalSources) {
        expect(evaluateSecurityMatrix({ source, capability })).toMatchObject({
          source,
          capability,
          decision: "warn",
          matched: "policy",
        });
      }
    },
  );

  it("returns require_confirm for unknown external capabilities", () => {
    expect(
      evaluateSecurityMatrix({ source: "github", capability: "launch_missiles" }),
    ).toMatchObject({
      source: "github",
      capability: "unknown",
      originalCapability: "launch_missiles",
      decision: "require_confirm",
      matched: "policy",
    });
  });

  it("returns allow for agent influencing exec", () => {
    expect(evaluateSecurityMatrix({ source: "agent", capability: "exec" })).toMatchObject({
      source: "agent",
      capability: "exec",
      decision: "allow",
      matched: "policy",
    });
  });

  it("returns allow for user influencing git", () => {
    expect(evaluateSecurityMatrix({ source: "user", capability: "git" })).toMatchObject({
      source: "user",
      capability: "git",
      decision: "allow",
      matched: "policy",
    });
  });

  it("normalizes unknown sources to unknown_external", () => {
    const evaluation = evaluateSecurityMatrix({
      source: "feed_reader",
      capability: "exec",
    });

    expect(evaluation).toMatchObject({
      source: "unknown_external",
      originalSource: "feed_reader",
      capability: "exec",
      decision: "block",
      matched: "policy",
    });
  });

  it("normalizes unknown capabilities to unknown", () => {
    const evaluation = evaluateSecurityMatrix({
      source: "email",
      capability: "launch_missiles",
    });

    expect(evaluation).toMatchObject({
      source: "email",
      capability: "unknown",
      originalCapability: "launch_missiles",
      decision: "require_confirm",
      matched: "policy",
    });
  });

  it("returns warn for trusted sources influencing unknown capabilities", () => {
    expect(
      evaluateSecurityMatrix({ source: "agent", capability: "launch_missiles" }),
    ).toMatchObject({
      source: "agent",
      capability: "unknown",
      originalCapability: "launch_missiles",
      decision: "warn",
      matched: "policy",
    });
  });

  it("allows a custom policy to override a default decision", () => {
    const policy = {
      web_fetch: {
        exec: {
          decision: "allow",
          reason: "Test policy override.",
        },
      },
    } satisfies SecurityMatrixPolicy;

    expect(evaluateSecurityMatrix({ source: "web_fetch", capability: "exec", policy })).toEqual({
      source: "web_fetch",
      originalSource: "web_fetch",
      capability: "exec",
      originalCapability: "exec",
      decision: "allow",
      reason: "Test policy override.",
      matched: "policy",
    });
  });

  it("keeps default policy rules when a partial custom policy has no matching rule", () => {
    const policy = {
      web_fetch: {
        exec: "block",
      },
    } satisfies SecurityMatrixPolicy;

    expect(
      evaluateSecurityMatrix({ source: "web_fetch", capability: "credential_access", policy }),
    ).toMatchObject({
      source: "web_fetch",
      capability: "credential_access",
      decision: "block",
      matched: "policy",
    });
  });

  it("explains the source, capability, decision, and match state", () => {
    const explanation = explainSecurityMatrixDecision(
      evaluateSecurityMatrix({ source: "web_fetch", capability: "exec" }),
    );

    expect(explanation).toContain("web_fetch -> exec");
    expect(explanation).toContain("decision=block");
    expect(explanation).toContain("matched=policy");
  });
});
