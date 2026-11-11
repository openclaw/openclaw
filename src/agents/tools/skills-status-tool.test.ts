import { beforeEach, expect, it, vi } from "vitest";
import { createSkillsStatusTool, resolveSkillsStatusParams } from "./skills-status-tool.js";

const mocks = vi.hoisted(() => ({ request: vi.fn(), assertActive: vi.fn() }));

vi.mock("./in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./in-process-gateway.js")>()),
  bindAgentToolGatewayRequest: vi.fn(() => mocks.request),
}));

vi.mock("../cron-creator-authority-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron-creator-authority-context.js")>()),
  bindActiveOperatorTurnAuthority: vi.fn(() => ({ assertActive: mocks.assertActive })),
}));

beforeEach(() => vi.clearAllMocks());

it("binds omitted selectors to the assembled session context", () => {
  expect(resolveSkillsStatusParams({}, { agentId: "main", sessionKey: "agent:main:main" })).toEqual(
    { agentId: "main", sessionKey: "agent:main:main" },
  );
  expect(resolveSkillsStatusParams({ refresh: true }, { agentId: "work" })).toEqual({
    agentId: "work",
    refresh: true,
  });
});

it("preserves explicit selections over session context", () => {
  expect(
    resolveSkillsStatusParams(
      { agentId: "research", sessionKey: "agent:research:x" },
      { agentId: "main", sessionKey: "agent:main:main" },
    ),
  ).toEqual({ agentId: "research", sessionKey: "agent:research:x" });
});

it("resolves the session's own agent for an explicit session key", () => {
  expect(
    resolveSkillsStatusParams({ sessionKey: "agent:research:x" }, { agentId: "main" }),
  ).toEqual({ sessionKey: "agent:research:x", agentId: "research" });
});

it("preserves an unqualified session alias for the canonical owner resolution", () => {
  expect(resolveSkillsStatusParams({ sessionKey: "main" }, { agentId: "work" })).toEqual({
    sessionKey: "main",
  });
  expect(resolveSkillsStatusParams({ sessionKey: "main", agentId: "work" }, {})).toEqual({
    sessionKey: "main",
    agentId: "work",
  });
});

it("refuses a malformed agent session key instead of inventing a default", () => {
  expect(() => resolveSkillsStatusParams({ sessionKey: "agent:" }, { agentId: "work" })).toThrow(
    "Malformed agent session key",
  );
});

it("does not inherit the active session for an explicit agent-only query", () => {
  expect(
    resolveSkillsStatusParams(
      { agentId: "research" },
      { agentId: "main", sessionKey: "agent:main:main" },
    ),
  ).toEqual({ agentId: "research" });
});

it("forwards the resolved status read to the gateway with the caller's authority", async () => {
  mocks.request.mockResolvedValue({
    workspaceDir: "/ws",
    managedSkillsDir: "/ws/skills",
    skills: [],
  });
  const tool = createSkillsStatusTool({
    assertSourceCurrent: () => {},
    sessionAgentId: "main",
    sessionKey: "agent:main:main",
  });
  const controller = new AbortController();

  const result = await tool.execute("status-call", {}, controller.signal);

  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
    method: "skills.status",
    params: { agentId: "main", sessionKey: "agent:main:main" },
    signal: controller.signal,
    assertDispatchCurrent: expect.any(Function),
    timeoutMs: 60_000,
  });
  expect(result).toMatchObject({
    details: { workspaceDir: "/ws", skills: [] },
  });
});
