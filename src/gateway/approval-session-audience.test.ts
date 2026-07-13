import { describe, expect, it, vi } from "vitest";
import { resolveApprovalSourceStreamKey } from "./approval-session-audience.js";

const getRuntimeConfigMock = vi.fn(() => ({}) as object);
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));
vi.mock("../agents/subagent-registry-read.js", () => ({
  buildLatestSubagentRunReadIndex: () => ({ getLatestSubagentRun: () => undefined }),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: () => undefined,
}));

describe("resolveApprovalSessionAudienceFromSources", () => {
  it("scopes a global source to the agent-specific stream key", () => {
    expect(resolveApprovalSourceStreamKey(" global ", "Work Agent")).toBe(
      "agent:work-agent:global",
    );
    expect(resolveApprovalSourceStreamKey("agent:work:child", "work")).toBe("agent:work:child");
  });
});

describe("resolveApprovalSourceStreamKey fallback scoping", () => {
  it("scopes raw fallback aliases to the raising agent", () => {
    expect(resolveApprovalSourceStreamKey("child", "work")).toBe("agent:work:child");
    expect(resolveApprovalSourceStreamKey("GLOBAL", "work")).toBe("agent:work:global");
  });

  it("keeps agent-scoped, unknown, and agent-less keys exact", () => {
    expect(resolveApprovalSourceStreamKey("agent:other:child", "work")).toBe("agent:other:child");
    expect(resolveApprovalSourceStreamKey("unknown", "work")).toBe("unknown");
    expect(resolveApprovalSourceStreamKey("child", null)).toBe("child");
  });
});
