import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  resolveApprovalSessionAudienceWithFallback,
  resolveApprovalSourceStreamKey,
} from "./approval-session-audience.js";

type GraphNode = {
  registry?: Partial<Record<"controllerSessionKey" | "requesterSessionKey", string | null>>;
  stored?: Partial<Record<"parentSessionKey" | "spawnedBy", string>>;
};

const scoped = (...keys: string[]) =>
  keys.map((key) => (key.startsWith("agent:") ? key : `agent:work:${key}`));
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
const readConfig = vi.fn(() => ({}) as object);
const readRun = vi.fn((sessionKey: string) => graph[sessionKey]?.registry);
const readEntry = vi.fn((scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored);
const readIndex = vi.fn(() => ({
  getLatestSubagentRun: readRun,
}));
const prepareRegistry = vi.fn(async () => true);
const registrySnapshot = {};
const readSnapshot = vi.fn<() => object | undefined>(() => registrySnapshot);

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => readConfig(),
}));
vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => ({
  buildLatestSubagentSessionListReadIndex: () => readIndex(),
  getLatestLiveSubagentRunByChildSessionKey: (key: string) => readRun(key),
}));
vi.mock("../agents/subagents/registry/subagent-registry-state.js", () => ({
  prepareOptionalSubagentSessionListReadCache: () => prepareRegistry(),
  getSubagentSessionListReadSnapshotIdentity: () => readSnapshot(),
}));
// mock-isolation: Audience tests compare fixture-owned persisted rows with the synthetic run registry.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: { sessionKey: string }) => readEntry(scope),
}));

beforeEach(() => {
  graph = {};
  readConfig.mockReset().mockReturnValue({});
  readRun.mockClear();
  readEntry
    .mockReset()
    .mockImplementation((scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored);
  readIndex.mockClear();
  prepareRegistry.mockReset().mockResolvedValue(true);
  readSnapshot.mockReset().mockReturnValue(registrySnapshot);
});

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

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
    prepareRegistry.mockImplementationOnce(async () => {
      memorySessionActorOwners.closeDatabase(location);
      return true;
    });
    await expect(audience(sessionKey)).rejects.toThrow();
  } finally {
    await actor.release();
  }
});

it("canonicalizes and bounds the breadth-first audience using current lineage", async () => {
  const cases: [string, Record<string, GraphNode>, string[]][] = [
    [" Child ", {}, ["child"]],
    [
      "child",
      {
        child: {
          ...registered("controller", "requester"),
          ...stored("stale-parent"),
        },
        controller: stored("controller-root"),
        requester: stored("requester-root"),
      },
      ["child", "controller", "requester", "controller-root", "requester-root"],
    ],
    [
      "child",
      {
        child: {
          ...registered(" ", null),
          stored: { parentSessionKey: "dashboard-parent", spawnedBy: "spawn-parent" },
        },
        "dashboard-parent": { stored: { spawnedBy: "root" } },
      },
      ["child", "dashboard-parent", "root"],
    ],
    [
      "agent:work:child",
      { child: registered("main", "agent:ops:main") },
      ["child", "main", "agent:ops:main"],
    ],
    [
      "child",
      { child: registered("parent", "child"), parent: stored("child") },
      ["child", "parent"],
    ],
    [
      "session-0",
      Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [
          `session-${index}`,
          stored(`session-${index + 1}`),
        ]),
      ),
      Array.from({ length: 64 }, (_, index) => `session-${index}`),
    ],
  ];
  for (const [source, nodes, expected] of cases) {
    graph = Object.fromEntries(Object.entries(nodes).map(([key, node]) => [scoped(key)[0], node]));
    await expectAudience(source, ...expected);
  }
});

it.each([
  { failure: "lineage", source: "main", expected: "agent:work:boss" },
  { failure: "config", source: "child", expected: "agent:work:child" },
])("scopes the source after $failure lookup fails", async ({ failure, source, expected }) => {
  readConfig.mockReturnValue({ session: { mainKey: "boss" } });
  const fail = () => {
    throw new Error(`${failure} unavailable`);
  };
  if (failure === "lineage") {
    readEntry.mockImplementationOnce(fail);
  } else {
    readConfig.mockImplementation(fail);
  }
  expect(await audience(source)).toEqual([expected]);
});

it("retains live and stored ancestors when the optional registry query is unavailable", async () => {
  prepareRegistry.mockResolvedValue(false);
  graph = {
    "agent:work:child": { registry: { requesterSessionKey: "parent" } },
    "agent:work:parent": stored("root"),
  };

  await expectAudience("child", "child", "parent", "root");
  expect(readIndex).not.toHaveBeenCalled();
});

it("rechecks registry readiness and current aliases after preparation settles", async () => {
  readConfig.mockReturnValue({ session: { mainKey: "old" } });
  readSnapshot.mockReturnValueOnce(undefined);
  prepareRegistry
    .mockImplementationOnce(async () => true)
    .mockImplementationOnce(async () => {
      readConfig.mockReturnValue({ session: { mainKey: "current" } });
      return true;
    });

  await expectAudience("main", "current");
});

it.each([
  new Error("registry admission retired"),
  new AggregateError([new Error("query"), new Error("cleanup")], "read cleanup failed"),
])("does not hide preparation failure: %s", async (error) => {
  prepareRegistry.mockRejectedValue(error);

  await expect(audience("child")).rejects.toBe(error);
  expect(readEntry).not.toHaveBeenCalled();
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
