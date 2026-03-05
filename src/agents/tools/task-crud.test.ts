import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createTaskCompleteTool } from "./task-crud.js";

vi.mock("../../infra/events/bus.js", () => ({ emit: vi.fn() }));
vi.mock("../../infra/retry.js", () => ({ retryAsync: vi.fn() }));
vi.mock("../../infra/task-lock.js", () => ({
  acquireTaskLock: vi.fn(async () => ({ release: vi.fn() })),
}));
vi.mock("../../infra/task-tracker.js", () => ({
  enableAgentManagedMode: vi.fn(),
  disableAgentManagedMode: vi.fn(),
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "test-agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
  listAgentIds: vi.fn(() => ["test-agent"]),
}));
vi.mock("./task-file-io.js", () => ({
  readTask: vi.fn(),
  writeTask: vi.fn(),
  deleteTask: vi.fn(),
  listTasks: vi.fn(async () => []),
  findActiveTask: vi.fn(),
  findSimilarTask: vi.fn(),
  appendToHistory: vi.fn(async () => "TASK_HISTORY.md"),
  formatTaskHistoryEntry: vi.fn(() => "entry"),
  updateCurrentTaskPointer: vi.fn(),
  hasActiveTasks: vi.fn(async () => false),
  generateTaskId: vi.fn(() => "test-id"),
  generateWorkSessionId: vi.fn(() => "ws-test"),
}));
vi.mock("./task-stop-guard.js", () => ({
  checkStopGuard: vi.fn(() => ({ blocked: false })),
}));

const minimalConfig = {
  agentDefaults: {},
  agents: {},
} as unknown as OpenClawConfig;

describe("task_complete tool", () => {
  it("description에 구조화된 summary 템플릿 포맷이 포함되어 있다", () => {
    const tool = createTaskCompleteTool({ config: minimalConfig });
    expect(tool).not.toBeNull();
    expect(tool!.description).toContain("작업 요약");
    expect(tool!.description).toContain("변경 내용");
    expect(tool!.description).toContain("참고 사항");
  });

  it("description에 마크다운 heading 포맷이 명시되어 있다", () => {
    const tool = createTaskCompleteTool({ config: minimalConfig });
    expect(tool!.description).toContain("## 작업 요약");
    expect(tool!.description).toContain("## 변경 내용");
    expect(tool!.description).toContain("## 참고 사항");
  });
});
