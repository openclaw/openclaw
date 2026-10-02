import path from "node:path";
import { expect, it, type Mock, type vi } from "vitest";
import type {
  AgentDeletionJournalCleanupPath,
  AgentDeletionJournalEntry,
} from "../../state/agent-deletion-journal.js";

export function cleanupPath(
  pathname: string,
  overrides: Partial<AgentDeletionJournalCleanupPath> = {},
): AgentDeletionJournalCleanupPath {
  return {
    path: pathname,
    canonicalPath: pathname,
    parentPath: path.dirname(pathname),
    sourcePaths: [pathname],
    kind: "target",
    dev: null,
    ino: null,
    coversDescendants: true,
    done: false,
    ...overrides,
  };
}

export function createEnoentError() {
  return createErrnoError("ENOENT");
}

export function createErrnoError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export function deletionJournal(
  overrides: Partial<AgentDeletionJournalEntry> = {},
): AgentDeletionJournalEntry {
  return {
    agentId: "test-agent",
    operationId: "delete-1",
    agentDir: "/journal/agent",
    workspaceDir: "/journal/workspace",
    sessionsDir: "/journal/sessions",
    createdAt: 1,
    cleanupCompleted: false,
    deleteFiles: true,
    databasePaths: [],
    cleanupPaths: [],
    ...overrides,
  };
}

export function registerAgentCreationCommitTests(fixture: {
  create: (params: Record<string, unknown>) => {
    respond: ReturnType<typeof vi.fn>;
    promise: void | Promise<void>;
  };
  configuredConfig: () => unknown;
  ensureAgentWorkspace: Mock;
  resolveAgentWorkspaceDir: Mock;
  writeConfigFile: Mock;
  hasDeletedAgentDatabases: Mock<() => boolean>;
  reviveAgentDatabases: Mock<(agentIds: readonly string[]) => Promise<void>>;
  logGatewayWarn: Mock;
}) {
  it("creates a new agent successfully", async () => {
    const { respond, promise } = fixture.create({
      name: "Test Agent",
      workspace: "/home/user/agents/test",
    });
    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent", name: "Test Agent" });
    expect(fixture.ensureAgentWorkspace).toHaveBeenCalled();
    expect(fixture.writeConfigFile).toHaveBeenCalled();
    expect(fixture.reviveAgentDatabases).not.toHaveBeenCalled();
  });

  it("defaults an omitted workspace", async () => {
    const { respond, promise } = fixture.create({ name: "Test Agent" });
    await promise;

    expect(fixture.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "test-agent");
    expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      workspace: "/resolved/workspace/test-agent",
    });
  });

  it("reports committed creation when deleted database reader revival fails", async () => {
    fixture.hasDeletedAgentDatabases.mockReturnValue(true);
    fixture.reviveAgentDatabases.mockRejectedValueOnce(new Error("worker acknowledgement failed"));
    const { respond, promise } = fixture.create({ name: "Test Agent" });

    await promise;

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    expect(fixture.configuredConfig()).toMatchObject({
      agents: { entries: { "test-agent": { name: "Test Agent" } } },
    });
    expect(fixture.writeConfigFile).toHaveBeenCalledExactlyOnceWith(fixture.configuredConfig());
    expect(fixture.reviveAgentDatabases).toHaveBeenCalledExactlyOnceWith(["test-agent"]);
    expect(fixture.logGatewayWarn).toHaveBeenCalledExactlyOnceWith(
      "agent config committed; worker reader revival will reconcile at next task: worker acknowledgement failed",
    );
  });
}

export function makeFileStat(params?: {
  size?: number;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
  nlink?: number;
}): import("node:fs").Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: params?.size ?? 10,
    mtimeMs: params?.mtimeMs ?? 1234,
    dev: params?.dev ?? 1,
    ino: params?.ino ?? 1,
    nlink: params?.nlink ?? 1,
  } as unknown as import("node:fs").Stats;
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export function expectRespondOk(
  respond: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(mockCallArg(respond)).toBe(true);
  const payload = expectRecordFields(mockCallArg(respond, 0, 1), expected);
  expect(mockCallArg(respond, 0, 2)).toBeUndefined();
  return payload;
}

export function expectRespondErrorContaining(respond: ReturnType<typeof vi.fn>, text: string) {
  expect(mockCallArg(respond)).toBe(false);
  expect(mockCallArg(respond, 0, 1)).toBeUndefined();
  const error = expectRecordFields(mockCallArg(respond, 0, 2), {});
  expectStringContaining(error.message, text);
  return error;
}

export function firstRespondResult(respond: ReturnType<typeof vi.fn>): unknown {
  return mockCallArg(respond, 0, 1);
}

export function expectStringContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).toContain(text);
}

export function expectStringNotContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).not.toContain(text);
}
