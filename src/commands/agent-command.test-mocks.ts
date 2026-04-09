import { vi } from "vitest";

vi.mock("../logging/subsystem.js", () => {
  const createMockLogger = () => ({
    subsystem: "test",
    isEnabled: vi.fn(() => true),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  });
  return {
    createSubsystemLogger: vi.fn(() => createMockLogger()),
  };
});

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
  loadWorkspaceSkillEntries: vi.fn(() => []),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));
