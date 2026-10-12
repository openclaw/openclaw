import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (scope: { sessionKey: string }) => loadSessionEntryMock(scope),
  loadSessionEntryReadOnly: (scope: { sessionKey: string }) => loadSessionEntryMock(scope),
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

describe("resolveApprovalSessionAudienceWithFallback", () => {
  it("canonicalizes and bounds the breadth-first audience using current lineage", async () => {
    const cases: { source: string; nodes: Record<string, GraphNode>; expected: string[] }[] = [
      { source: " Child ", nodes: {}, expected: ["agent:work:child"] },
      {
        source: "child",
        nodes: {
          "agent:work:child": {
            registry: { controllerSessionKey: "controller", requesterSessionKey: "requester" },
            stored: { parentSessionKey: "stale-parent" },
          },
          "agent:work:controller": { stored: { parentSessionKey: "controller-root" } },
          "agent:work:requester": { stored: { parentSessionKey: "requester-root" } },
        },
        expected: [
          "agent:work:child",
          "agent:work:controller",
          "agent:work:requester",
          "agent:work:controller-root",
          "agent:work:requester-root",
        ],
      },
      {
        source: "child",
        nodes: {
          "agent:work:child": {
            registry: { controllerSessionKey: " ", requesterSessionKey: null },
            stored: { parentSessionKey: "dashboard-parent", spawnedBy: "spawn-parent" },
          },
          "agent:work:dashboard-parent": { stored: { spawnedBy: "root" } },
        },
        expected: ["agent:work:child", "agent:work:dashboard-parent", "agent:work:root"],
      },
      {
        source: "agent:work:child",
        nodes: {
          "agent:work:child": {
            registry: { controllerSessionKey: "main", requesterSessionKey: "agent:ops:main" },
          },
        },
        expected: ["agent:work:child", "agent:work:main", "agent:ops:main"],
      },
      {
        source: "child",
        nodes: {
          "agent:work:child": {
            registry: { controllerSessionKey: "parent", requesterSessionKey: "child" },
          },
          "agent:work:parent": { stored: { parentSessionKey: "child" } },
        },
        expected: ["agent:work:child", "agent:work:parent"],
      },
      {
        source: "session-0",
        nodes: Object.fromEntries(
          Array.from({ length: 70 }, (_, index) => [
            `agent:work:session-${index}`,
            { stored: { parentSessionKey: `session-${index + 1}` } },
          ]),
        ),
        expected: Array.from({ length: 64 }, (_, index) => `agent:work:session-${index}`),
      },
    ];
    for (const { source, nodes, expected } of cases) {
      graph = nodes;
      expect(await resolveApprovalSessionAudienceWithFallback(source, "work"), source).toEqual(
        expected,
      );
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
    expect(await resolveApprovalSessionAudienceWithFallback(source, "work")).toEqual([expected]);
  });

  it("retains live and stored ancestors when the optional registry query is unavailable", async () => {
    prepareRegistryMock.mockResolvedValue(false);
    graph = {
      "agent:work:child": { registry: { requesterSessionKey: "parent" } },
      "agent:work:parent": { stored: { parentSessionKey: "root" } },
    };

    expect(await resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:parent",
      "agent:work:root",
    ]);
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

    expect(await resolveApprovalSessionAudienceWithFallback("main", "work")).toEqual([
      "agent:work:current",
    ]);
  });

  it.each([
    new Error("registry admission retired"),
    new AggregateError([new Error("query"), new Error("cleanup")], "read cleanup failed"),
  ])("does not hide preparation failure: %s", async (error) => {
    prepareRegistryMock.mockRejectedValue(error);

    await expect(resolveApprovalSessionAudienceWithFallback("child", "work")).rejects.toBe(error);
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
