import { describe, expect, it } from "vitest";
import { mergeExecApprovalsSocketDefaults, normalizeExecApprovals } from "./exec-approvals.js";

describe("mergeExecApprovalsSocketDefaults", () => {
  it("prefers normalized socket, then current, then default path", () => {
    const normalized = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/a.sock", token: "a" },
    });
    const current = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/b.sock", token: "b" },
    });
    const merged = mergeExecApprovalsSocketDefaults({ normalized, current });
    expect(merged.socket?.path).toBe("/tmp/a.sock");
    expect(merged.socket?.token).toBe("a");
  });

  it("falls back to current token when missing in normalized", () => {
    const normalized = normalizeExecApprovals({ version: 1, agents: {} });
    const current = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/b.sock", token: "b" },
    });
    const merged = mergeExecApprovalsSocketDefaults({ normalized, current });
    expect(merged.socket?.path).toBeTruthy();
    expect(merged.socket?.token).toBe("b");
  });
});
