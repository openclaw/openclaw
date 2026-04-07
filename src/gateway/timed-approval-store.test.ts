import { describe, expect, it, beforeEach } from "vitest";
import { TimedApprovalStore } from "./timed-approval-store.js";

describe("TimedApprovalStore", () => {
  let store: TimedApprovalStore;

  beforeEach(() => {
    store = new TimedApprovalStore();
  });

  it("returns matching entry within window", () => {
    store.add({
      commandPattern: "git push",
      agentId: null,
      grantedBy: "discord:123",
      approvedUntil: Date.now() + 60_000,
    });
    const result = store.findActive("git push --force origin main");
    expect(result).not.toBeNull();
    expect(result?.commandPattern).toBe("git push");
  });

  it("returns null after expiry", () => {
    store.add({
      commandPattern: "git push",
      agentId: null,
      grantedBy: "discord:123",
      approvedUntil: Date.now() - 1, // already expired
    });
    expect(store.findActive("git push --force origin main")).toBeNull();
  });

  it("returns null when no timed approval exists", () => {
    expect(store.findActive("systemctl restart nginx")).toBeNull();
  });

  it("respects agentId scoping", () => {
    store.add({
      commandPattern: "git push",
      agentId: "general-worker",
      grantedBy: "discord:123",
      approvedUntil: Date.now() + 60_000,
    });
    // Correct agent
    expect(store.findActive("git push --force", "general-worker")).not.toBeNull();
    // Different agent
    expect(store.findActive("git push --force", "other-agent")).toBeNull();
  });

  it("null agentId matches any agent", () => {
    store.add({
      commandPattern: "npm test",
      agentId: null,
      grantedBy: "discord:123",
      approvedUntil: Date.now() + 60_000,
    });
    expect(store.findActive("npm test", "any-agent")).not.toBeNull();
    expect(store.findActive("npm test", null)).not.toBeNull();
  });

  it("listActive returns only non-expired entries", () => {
    store.add({
      commandPattern: "active",
      agentId: null,
      grantedBy: "discord:123",
      approvedUntil: Date.now() + 60_000,
    });
    store.add({
      commandPattern: "expired",
      agentId: null,
      grantedBy: "discord:123",
      approvedUntil: Date.now() - 1,
    });
    const active = store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].commandPattern).toBe("active");
  });
});
