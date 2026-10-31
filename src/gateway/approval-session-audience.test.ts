import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
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
  entry?: GraphNode["stored"],
): GraphNode => ({ registry: { controllerSessionKey, requesterSessionKey }, stored: entry });
const audience = (source: string) => resolveApprovalSessionAudienceWithFallback(source, "work");
async function expectAudience(source: string, ...keys: string[]) {
  expect(await audience(source), source).toEqual(scoped(...keys));
}

let graph: Record<string, GraphNode> = {};
const readConfig = vi.fn(() => ({}) as object);
const readRun = (sessionKey: string) => graph[sessionKey]?.registry;
const entryFor = (scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored;
const readEntry = vi.fn(entryFor);
const prepareRegistry = vi.fn(async () => true);
const registrySnapshot = {};
const readSnapshot = vi.fn<() => object | undefined>(() => registrySnapshot);

// mock-isolation: Resolve audience scope from fixture configuration, not operator state.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => readConfig() }));
// mock-isolation: Traverse the fixture-owned run graph without loading the live registry.
vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => ({
  buildLatestSubagentSessionListReadIndex: () => ({ getLatestSubagentRun: readRun }),
  getLatestLiveSubagentRunByChildSessionKey: (key: string) => readRun(key),
}));
// mock-isolation: Control registry publication and preparation for each lineage scenario.
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
  readEntry.mockReset().mockImplementation(entryFor);
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
    const entry: InternalSessionEntry = {
      sessionId: "private-child",
      updatedAt: 1,
      incognito: true,
      parentSessionKey: "parent",
    };
    await mutate({ type: "session.entry.create", input: { entry } });
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
  const chain = Array.from({ length: 70 }, (_, index) => `session-${index}`);
  const cases: [string, Record<string, GraphNode>, string[]][] = [
    [" Child ", {}, ["child"]],
    [
      "child",
      {
        child: registered("controller", "requester", { parentSessionKey: "stale-parent" }),
        controller: stored("controller-root"),
        requester: stored("requester-root"),
      },
      ["child", "controller", "requester", "controller-root", "requester-root"],
    ],
    [
      "child",
      {
        child: registered(" ", null, {
          parentSessionKey: "dashboard-parent",
          spawnedBy: "spawn-parent",
        }),
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
      Object.fromEntries(chain.map((key, index) => [key, stored(`session-${index + 1}`)])),
      chain.slice(0, 64),
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
