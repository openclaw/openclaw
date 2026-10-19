import type { Stats } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, type vi, type Mock } from "vitest";
import type {
  AgentDeletionJournalCleanupPath,
  AgentDeletionJournalEntry,
} from "../../state/agent-deletion-journal.js";
import { expectObjectFields as expectRecordFields } from "../../test-utils/mock-call-assertions.js";

export { expectRecordFields };

export type MockAgentEntry = {
  id: string;
  identity?: Partial<Record<"name" | "theme" | "emoji" | "avatar", string>>;
} & Partial<Record<"name" | "workspace" | "agentDir" | "model", string>>;

export type MockConfig = {
  agents?: {
    entries?: Record<string, Omit<MockAgentEntry, "id">>;
  };
};

export function agentConfig(
  entries: Record<string, Omit<MockAgentEntry, "id">>,
  defaults?: Record<string, unknown>,
) {
  return { agents: { entries, ...(defaults ? { defaults } : {}) } };
}

export function getAgentList(cfg: unknown): MockAgentEntry[] {
  return Object.entries((cfg as MockConfig | undefined)?.agents?.entries ?? {}).map(([id, entry]) =>
    Object.assign({}, entry, { id }),
  );
}

export function mergeAgentConfig(cfg: unknown, opts: unknown): MockConfig {
  const config = (cfg as MockConfig | undefined) ?? {};
  const params = (opts as Partial<Omit<MockAgentEntry, "id" | "model">> & {
    agentId?: string;
    model?: string | null;
  }) ?? { agentId: "" };
  const agentId = params.agentId ?? "";
  const base = config.agents?.entries?.[agentId];
  const nextEntry: Omit<MockAgentEntry, "id"> = {
    ...base,
    ...(params.name ? { name: params.name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.identity ? { identity: { ...base?.identity, ...params.identity } } : {}),
  };
  if (params.model === null) {
    delete nextEntry.model;
  }
  return {
    ...config,
    agents: { ...config.agents, entries: { ...config.agents?.entries, [agentId]: nextEntry } },
  };
}

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

export const createEnoentError = () => createErrnoError("ENOENT");

export function createErrnoError(code: string) {
  return Object.assign(new Error(code), { code });
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
    phase: "retiring",
    deleteFiles: true,
    databasePaths: [],
    cleanupPaths: [],
    ...overrides,
  };
}

export function expectUncalled(...callbacks: unknown[]) {
  for (const callback of callbacks) {
    expect(callback).not.toHaveBeenCalled();
  }
}

export function makeFileStat(
  params: Partial<Pick<Stats, "size" | "mtimeMs" | "dev" | "ino" | "nlink">> = {},
): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: params.size ?? 10,
    mtimeMs: params.mtimeMs ?? 1234,
    dev: params.dev ?? 1,
    ino: params.ino ?? 1,
    nlink: params.nlink ?? 1,
  } as unknown as Stats;
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  return expectDefined(mock.mock.calls[callIndex], `Expected mock call ${callIndex}`)[argIndex];
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

export function expectPendingDeletion(
  respond: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(respond).toHaveBeenCalledWith(
    false,
    expect.objectContaining(expected),
    expect.objectContaining({
      code: "UNAVAILABLE",
      message: expect.stringContaining("deletion cleanup is still pending"),
    }),
  );
  return expectRecordFields(mockCallArg(respond, 0, 1), expected);
}

export function expectRespondErrorContaining(respond: ReturnType<typeof vi.fn>, text: string) {
  expect(mockCallArg(respond)).toBe(false);
  expect(mockCallArg(respond, 0, 1)).toBeUndefined();
  const error = expectRecordFields(mockCallArg(respond, 0, 2), {});
  expect(error.message).toEqual(expect.stringContaining(text));
  return error;
}

export function createTrashAssertions(
  movePathToTrash: Mock<(pathname?: string) => Promise<string>>,
) {
  return {
    expectTrashedWithinParent: (pathname: string, declaredPath = pathname): void => {
      expect(movePathToTrash).toHaveBeenCalledWith(
        pathname,
        expect.objectContaining({
          allowedRoots: expect.arrayContaining([path.dirname(declaredPath)]),
        }),
      );
    },
    expectNotTrashed: (...paths: string[]): void => {
      const targets = movePathToTrash.mock.calls.map(([target]) => target);
      for (const pathname of paths) {
        expect(targets).not.toContain(pathname);
      }
    },
  };
}
