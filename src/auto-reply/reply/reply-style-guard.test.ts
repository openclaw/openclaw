import { describe, expect, it } from "vitest";
import {
  appendChiefReplyStyleGuard,
  buildChiefReplyStyleGuard,
  isChiefReplyStyleGuardTarget,
} from "./reply-style-guard.js";

describe("reply-style-guard", () => {
  it("targets chief by agent id", () => {
    expect(isChiefReplyStyleGuardTarget({ agentId: "chief" })).toBe(true);
    expect(isChiefReplyStyleGuardTarget({ agentId: "work" })).toBe(false);
  });

  it("targets chief by workspace name", () => {
    expect(
      isChiefReplyStyleGuardTarget({ workspaceDir: "/Users/imadeddine/.openclaw/workspace-chief" }),
    ).toBe(true);
    expect(
      isChiefReplyStyleGuardTarget({ workspaceDir: "/Users/imadeddine/.openclaw/workspace-work" }),
    ).toBe(false);
  });

  it("builds a concise chief guard with greeting-specific guidance", () => {
    const guard = buildChiefReplyStyleGuard({
      agentId: "chief",
      workspaceDir: "/tmp/workspace-chief",
      userText: "hi",
    });
    expect(guard).toContain("Chief Reply Style Guard");
    expect(guard).toContain("Default to clean, concise, directly useful replies.");
    expect(guard).toContain("Do not narrate internal delegation");
    expect(guard).toContain("For greetings or simple check-ins");
  });

  it("skips heartbeat runs", () => {
    expect(
      buildChiefReplyStyleGuard({
        agentId: "chief",
        workspaceDir: "/tmp/workspace-chief",
        isHeartbeat: true,
        userText: "hi",
      }),
    ).toBeUndefined();
  });

  it("does not append the guard twice", () => {
    const existing = "## Chief Reply Style Guard\n- existing";
    expect(appendChiefReplyStyleGuard(existing, "## Chief Reply Style Guard\n- next")).toBe(
      existing,
    );
  });
});
