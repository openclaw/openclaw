import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  resolveApprovalSessionAudienceWithFallback,
  resolveApprovalSourceStreamKey,
} from "./approval-session-audience.js";

type GraphNode = {
  registry?: {
    controllerSessionKey?: string | null;
    requesterSessionKey?: string | null;
  };
  stored?: {
    parentSessionKey?: string;
    spawnedBy?: string;
  };
};

const scoped = (...keys: string[]) => keys.map((key) => `agent:work:${key}`);
const stored = (parentSessionKey: string): GraphNode => ({ stored: { parentSessionKey } });
const registered = (
  controllerSessionKey: string | null,
  requesterSessionKey: string | null,
): GraphNode => ({ registry: { controllerSessionKey, requesterSessionKey } });
const audience = (source: string) => resolveApprovalSessionAudienceWithFallback(source, "work");
async function expectAudience(source: string, ...keys: string[]) {
  expect(await audience(source), source).toEqual(scoped(...keys));
}

let graph: Record<string, GraphNode> = {};
const getRuntimeConfigMock = vi.fn(() => ({}) as object);
const getLatestSubagentRunMock = vi.fn((sessionKey: string) => graph[sessionKey]?.registry);
const loadSessionEntryMock = vi.fn(
  (scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored,
);
const buildLatestSubagentSessionListReadIndexMock = vi.fn(() => ({
  getLatestSubagentRun: getLatestSubagentRunMock,
}));
const prepareRegistryMock = vi.fn(async () => true);
const registrySnapshot = {};
const registrySnapshotMock = vi.fn<() => object | undefined>(() => registrySnapshot);

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));
vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => ({
  buildLatestSubagentSessionListReadIndex: () => buildLatestSubagentSessionListReadIndexMock(),
  getLatestLiveSubagentRunByChildSessionKey: (key: string) => getLatestSubagentRunMock(key),
}));
vi.mock("../agents/subagents/registry/subagent-registry-state.js", () => ({
  prepareOptionalSubagentSessionListReadCache: () => prepareRegistryMock(),
  getSubagentSessionListReadSnapshotIdentity: () => registrySnapshotMock(),
}));
// mock-isolation: Audience tests compare fixture-owned persisted rows with the synthetic run registry.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: { sessionKey: string }) =>
    loadSessionEntryMock(scope),
}));

beforeEach(() => {
  graph = {};
  getRuntimeConfigMock.mockReset().mockReturnValue({});
  getLatestSubagentRunMock
    .mockReset()
    .mockImplementation((sessionKey: string) => graph[sessionKey]?.registry);
  loadSessionEntryMock
    .mockReset()
    .mockImplementation((scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored);
  buildLatestSubagentSessionListReadIndexMock.mockReset().mockReturnValue({
    getLatestSubagentRun: getLatestSubagentRunMock,
  });
  prepareRegistryMock.mockReset().mockResolvedValue(true);
  registrySnapshotMock.mockReset().mockReturnValue(registrySnapshot);
});

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

describe("resolveApprovalSessionAudienceWithFallback", () => {
  it("reads current memory lineage without creating a missing owner and refuses a closed source", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/approval-memory");
    const sessionKey = "agent:work:dashboard:incognito-child";
    const location = {
      agentId: "work",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "work" }),
    };
    await expectAudience(sessionKey, "dashboard:incognito-child");
    expect(memorySessionActorOwners.read(location)).toBeUndefined();
    const owner = memorySessionActorOwners.get(location);
    const actor = await owner.acquire(
      { sessionKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    const mutate = async (operation: Parameters<NonNullable<typeof actor.storage>["mutate"]>[0]) =>
      expect((await actor.storage!.mutate(operation, authority)).kind).toBe("committed");
    try {
      await mutate({
        type: "session.entry.create",
        input: {
          entry: {
            sessionId: "private-child",
            updatedAt: 1,
            incognito: true,
            parentSessionKey: "parent",
          },
        },
      });
      graph = { "agent:work:parent": stored("root") };
      await expectAudience(sessionKey, "dashboard:incognito-child", "parent", "root");
      await mutate({
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { parentSessionKey: "next-parent" } } },
      });
      await expectAudience(sessionKey, "dashboard:incognito-child", "next-parent");
      prepareRegistryMock.mockImplementationOnce(async () => {
        memorySessionActorOwners.closeDatabase(location);
        return true;
      });
      await expect(audience(sessionKey)).rejects.toThrow();
    } finally {
      await actor.release();
    }
  });

  it("canonicalizes and bounds the breadth-first audience using current lineage", async () => {
    const cases: { source: string; nodes: Record<string, GraphNode>; expected: string[] }[] = [
      { source: " Child ", nodes: {}, expected: scoped("child") },
      {
        source: "child",
        nodes: {
          "agent:work:child": {
            ...registered("controller", "requester"),
            ...stored("stale-parent"),
          },
          "agent:work:controller": stored("controller-root"),
          "agent:work:requester": stored("requester-root"),
        },
        expected: scoped("child", "controller", "requester", "controller-root", "requester-root"),
      },
      {
        source: "child",
        nodes: {
          "agent:work:child": {
            ...registered(" ", null),
            stored: { parentSessionKey: "dashboard-parent", spawnedBy: "spawn-parent" },
          },
          "agent:work:dashboard-parent": { stored: { spawnedBy: "root" } },
        },
        expected: scoped("child", "dashboard-parent", "root"),
      },
      {
        source: "agent:work:child",
        nodes: {
          "agent:work:child": registered("main", "agent:ops:main"),
        },
        expected: ["agent:work:child", "agent:work:main", "agent:ops:main"],
      },
      {
        source: "child",
        nodes: {
          "agent:work:child": registered("parent", "child"),
          "agent:work:parent": stored("child"),
        },
        expected: scoped("child", "parent"),
      },
      {
        source: "session-0",
        nodes: Object.fromEntries(
          Array.from({ length: 70 }, (_, index) => [
            `agent:work:session-${index}`,
            stored(`session-${index + 1}`),
          ]),
        ),
        expected: Array.from({ length: 64 }, (_, index) => `agent:work:session-${index}`),
      },
    ];
    for (const { source, nodes, expected } of cases) {
      graph = nodes;
      expect(await audience(source), source).toEqual(expected);
    }
  });

  it.each([
    { failure: "lineage", source: "main", expected: "agent:work:boss" },
    { failure: "config", source: "child", expected: "agent:work:child" },
  ])("scopes the source after $failure lookup fails", async ({ failure, source, expected }) => {
    getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "boss" } });
    const fail = () => {
      throw new Error(`${failure} unavailable`);
    };
    if (failure === "lineage") {
      loadSessionEntryMock.mockImplementationOnce(fail);
    } else {
      getRuntimeConfigMock.mockImplementation(fail);
    }
    expect(await audience(source)).toEqual([expected]);
  });

  it("retains live and stored ancestors when the optional registry query is unavailable", async () => {
    prepareRegistryMock.mockResolvedValue(false);
    graph = {
      "agent:work:child": { registry: { requesterSessionKey: "parent" } },
      "agent:work:parent": stored("root"),
    };

    await expectAudience("child", "child", "parent", "root");
    expect(buildLatestSubagentSessionListReadIndexMock).not.toHaveBeenCalled();
  });

  it("rechecks registry readiness and current aliases after preparation settles", async () => {
    getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "old" } });
    registrySnapshotMock.mockReturnValueOnce(undefined);
    prepareRegistryMock
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => {
        getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "current" } });
        return true;
      });

    await expectAudience("main", "current");
  });

  it.each([
    new Error("registry admission retired"),
    new AggregateError([new Error("query"), new Error("cleanup")], "read cleanup failed"),
  ])("does not hide preparation failure: %s", async (error) => {
    prepareRegistryMock.mockRejectedValue(error);

    await expect(audience("child")).rejects.toBe(error);
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
  });
});

it("scopes raw fallback aliases without changing explicit, unknown, or agent-less keys", () => {
  for (const [key, agent, expected] of [
    ["child", "work", "agent:work:child"],
    ["GLOBAL", "work", "agent:work:global"],
    ["agent:other:child", "work", "agent:other:child"],
    ["unknown", "work", "unknown"],
    ["child", null, "child"],
  ] as const) {
    expect(resolveApprovalSourceStreamKey(key, agent), key).toBe(expected);
  }
});
