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
  it("keeps the canonical source first when it has no ancestors", async () => {
    expect(await resolveApprovalSessionAudienceWithFallback(" Child ", "work")).toEqual([
      "agent:work:child",
    ]);
  });

  it("walks registry controller and requester branches breadth-first", async () => {
    graph = {
      "agent:work:child": {
        registry: {
          controllerSessionKey: "controller",
          requesterSessionKey: "requester",
        },
        stored: { parentSessionKey: "stale-parent" },
      },
      "agent:work:controller": { stored: { parentSessionKey: "controller-root" } },
      "agent:work:requester": { stored: { parentSessionKey: "requester-root" } },
    };

    expect(await resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:controller",
      "agent:work:requester",
      "agent:work:controller-root",
      "agent:work:requester-root",
    ]);
  });

  it("falls back to stored lineage when registry lineage is unusable", async () => {
    graph = {
      "agent:work:child": {
        registry: { controllerSessionKey: " ", requesterSessionKey: null },
        stored: { parentSessionKey: "dashboard-parent", spawnedBy: "spawn-parent" },
      },
      "agent:work:dashboard-parent": { stored: { spawnedBy: "root" } },
    };

    expect(await resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:dashboard-parent",
      "agent:work:root",
    ]);
  });

  it("scopes relative aliases while preserving explicit cross-agent parents", async () => {
    graph = {
      "agent:work:child": {
        registry: {
          controllerSessionKey: "main",
          requesterSessionKey: "agent:ops:main",
        },
      },
    };

    expect(await resolveApprovalSessionAudienceWithFallback("agent:work:child", "work")).toEqual([
      "agent:work:child",
      "agent:work:main",
      "agent:ops:main",
    ]);
  });

  it("guards cycles and includes each session once", async () => {
    graph = {
      "agent:work:child": {
        registry: { controllerSessionKey: "parent", requesterSessionKey: "child" },
      },
      "agent:work:parent": { stored: { parentSessionKey: "child" } },
    };

    expect(await resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:parent",
    ]);
  });

  it("caps a malformed lineage graph at 64 sessions", async () => {
    graph = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `agent:work:session-${index}`,
        { stored: { parentSessionKey: `session-${index + 1}` } },
      ]),
    );

    const audience = await resolveApprovalSessionAudienceWithFallback("session-0", "work");

    expect(audience).toHaveLength(64);
    expect(audience[0]).toBe("agent:work:session-0");
    expect(audience.at(-1)).toBe("agent:work:session-63");
  });

  it("canonicalizes configured main-key aliases when lineage lookup throws", async () => {
    getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "boss" } });
    loadSessionEntryMock.mockImplementationOnce(() => {
      throw new Error("session lineage unavailable");
    });

    expect(await resolveApprovalSessionAudienceWithFallback("main", "work")).toEqual([
      "agent:work:boss",
    ]);
  });

  it("scopes unscoped aliases even when config loading throws", async () => {
    getRuntimeConfigMock.mockImplementation(() => {
      throw new Error("config unavailable");
    });

    expect(await resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
    ]);
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
