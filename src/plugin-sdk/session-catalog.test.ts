import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import {
  createSessionCatalogFamily,
  sessionCatalogPaging,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogFamilyOptions,
  type SessionCatalogSession,
  type SessionCatalogTranscriptItem,
} from "./session-catalog.js";

const messages = {
  listNotObject: "list object required",
  unknownListParameter: (key: string) => `unknown list: ${key}`,
  invalidSearchTerm: "bad search",
  readNotObject: "read object required",
  unknownReadParameter: (key: string) => `unknown read: ${key}`,
  invalidThreadId: "bad thread",
};

const session = (threadId: string): SessionCatalogSession => ({
  threadId,
  status: "stored",
  archived: false,
  canContinue: true,
  canArchive: false,
});

function unexpected(): never {
  throw new Error("Unexpected catalog operation");
}

function barrier() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered,
    release,
    pause: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

it("owns canonical list/read parameter and cursor parsing", () => {
  const listOptions = { searchMaxLength: 20, messages };
  const read = (value: unknown, cursorMaxLength?: number) =>
    sessionCatalogPaging.parseReadParams(value, {
      threadIdMaxLength: 32,
      threadIdPattern: /^(?!-)[a-z0-9-]+$/u,
      messages,
      cursorMaxLength,
    });
  const cursor = sessionCatalogPaging.encodeCursor(2);
  expect(
    sessionCatalogPaging.parseListParams(
      { searchTerm: "  needle  ", limit: 4, cursor },
      listOptions,
    ),
  ).toEqual({ searchTerm: "needle", limit: 4, cursor });
  expect(read({ threadId: "thread-1", cursor })).toEqual({
    threadId: "thread-1",
    limit: 20,
    cursor,
  });
  expect(sessionCatalogPaging.isExactCursor(cursor)).toBe(true);
  expect(sessionCatalogPaging.isExactCursor(`${cursor}=`)).toBe(false);
  expect(() => sessionCatalogPaging.parseListParams({ extra: true }, listOptions)).toThrow(
    "unknown list: extra",
  );
  expect(() => read({ threadId: "--help" })).toThrow("bad thread");
  const nativeCursor = "a".repeat(200);
  const readOptions = { threadIdMaxLength: 32, threadIdPattern: /^thread-\d+$/u, messages };
  const nativeRequest = { threadId: "thread-1", cursor: nativeCursor };
  expect(() => sessionCatalogPaging.parseReadParams(nativeRequest, readOptions)).toThrow(
    "cursor is invalid",
  );
  expect(
    sessionCatalogPaging.parseReadParams(nativeRequest, { ...readOptions, cursorMaxLength: 200 }),
  ).toEqual({ threadId: "thread-1", limit: 20, cursor: nativeCursor });
  expect(() =>
    sessionCatalogPaging.parseReadParams(
      { ...nativeRequest, cursor: `${nativeCursor}a` },
      { ...readOptions, cursorMaxLength: 200 },
    ),
  ).toThrow("cursor is invalid");
});

it("pages newest-first by source order with non-monotonic timestamps", () => {
  const timestamps = [4, 1, 3, 0, 2].map((second) => `2026-08-30T12:00:0${second}Z`);
  const items: SessionCatalogTranscriptItem[] = ["z", "2", "10", "a", "1"].map((id, index) => ({
    id,
    type: "agentMessage",
    text: id,
    timestamp: timestamps[index],
  }));
  const page = (cursor?: string) =>
    sessionCatalogPaging.boundTranscriptPage(items, 2, sessionCatalogPaging.decodeCursor(cursor));
  const latest = page();
  expect(latest.items.map((item) => item.id)).toEqual(["1", "a"]);
  const older = page(latest.nextCursor);
  expect(older.items.map((item) => item.id)).toEqual(["10", "2"]);
  const oldest = page(older.nextCursor);
  expect(oldest.items.map((item) => item.id)).toEqual(["z"]);
  expect(oldest.nextCursor).toBeUndefined();
  expect(items.map((item) => item.id)).toEqual(["z", "2", "10", "a", "1"]);
});

function createFamilyFixture() {
  const runtime = {
    nodes: {
      list: vi.fn().mockResolvedValue({
        nodes: [
          {
            nodeId: "node-1",
            displayName: "Remote",
            connected: true,
            commands: ["family.list", "family.read", "family.terminal"],
          },
        ],
      }),
      invoke: vi.fn(unexpected),
    },
  } as unknown as PluginRuntime;
  const create = vi.fn<SessionCatalogFamilyOptions["continuation"]["create"]>(unexpected);
  const complete = vi.fn<SessionCatalogFamilyOptions["continuation"]["complete"]>(unexpected);
  const options: SessionCatalogFamilyOptions = {
    runtime,
    local: {
      hostId: "gateway",
      label: "Local Family",
      available: () => true,
      list: async () => ({ sessions: [session("local-thread")] }),
      read: unexpected,
      assertAccess: vi.fn(),
    },
    node: {
      listCommand: "family.list",
      readCommand: "family.read",
      terminalCommand: "family.terminal",
      timeoutMs: 1_000,
      maxHosts: 10,
      maxPageLimit: 100,
      sessionIdPattern: /^[a-z0-9-]+$/u,
    },
    capabilities: {
      local: () => ({ canContinue: true, canOpenTerminal: false }),
      node: () => ({ canContinue: false, canOpenTerminal: true }),
      project: (value, capabilities) => ({ ...value, ...capabilities }),
    },
    messages: {
      invalidNodeCursor: "bad node cursor",
      invalidNodeSessionPage: "bad node sessions",
      invalidNodeTranscriptPage: "bad node transcript",
      invalidHostId: "bad host",
      localReadFailed: "local unavailable",
      nodeInvokeFailed: "node unavailable",
      nodeReadUnavailable: "node read unavailable",
      nodeTerminalUnavailable: "node terminal unavailable",
      sessionUnavailable: "session unavailable",
    },
    continuation: {
      resolveAgentId: (agentId = "main") => agentId,
      availability: () => ({ available: true }),
      listAdopted: () => new Map(),
      loadSession: async (threadId) => session(threadId),
      validateSession: vi.fn(),
      create,
      complete,
      nodeReadOnlyMessage: "nodes are read-only",
    },
    terminal: {
      executable: "family",
      args: unexpected,
      title: unexpected,
      requireLocalSession: unexpected,
      unavailableMessage: "family unavailable",
    },
    checkUpstreamActivity: unexpected,
  };
  const provider = createSessionCatalogFamily(options, sessionCatalogPaging.isExactCursor);
  return { provider, options, create, complete };
}

it.each(["local", "nodes"] as const)(
  "does not start node work when the owner retires during %s discovery",
  async (stage) => {
    const { provider, options } = createFamilyFixture();
    const { entered, release, pause } = barrier();
    const controller = new AbortController();
    const project = vi.fn(options.capabilities.project);
    options.capabilities.project = project;
    if (stage === "local") {
      const original = options.local.list;
      options.local.list = async (query) => {
        await pause();
        return original(query);
      };
    } else {
      const listNodes = vi.mocked(options.runtime.nodes.list);
      const original = listNodes.getMockImplementation()!;
      listNodes.mockImplementation(async (query) => {
        await pause();
        return original(query);
      });
    }
    const pending = provider.list({ agentId: "main", signal: controller.signal });
    await entered.promise;
    const reason = new Error("catalog owner retired");
    controller.abort(reason);
    release.resolve();
    await expect(pending).rejects.toBe(reason);

    expect(options.runtime.nodes.invoke).not.toHaveBeenCalled();
    if (stage === "local") {
      expect(project).not.toHaveBeenCalled();
      expect(options.runtime.nodes.list).not.toHaveBeenCalled();
    }
  },
);

it("delivers owner retirement to an active node invocation", async () => {
  const { provider, options } = createFamilyFixture();
  const { entered, release } = barrier();
  const controller = new AbortController();
  let transportRetired = false;
  vi.mocked(options.runtime.nodes.invoke).mockImplementation(async ({ signal }) => {
    const retire = () => {
      transportRetired = true;
      release.resolve();
    };
    signal?.addEventListener("abort", retire, { once: true });
    entered.resolve();
    try {
      await release.promise;
      return { payloadJSON: JSON.stringify({ sessions: [] }) };
    } finally {
      signal?.removeEventListener("abort", retire);
    }
  });
  const pending = provider.list({
    agentId: "main",
    hostIds: ["node:node-1"],
    signal: controller.signal,
  });
  try {
    await entered.promise;
    controller.abort(new Error("catalog owner retired"));
    expect(transportRetired).toBe(true);
  } finally {
    release.resolve();
    await pending.catch(() => []);
  }
});

it("does not retry local publication as a discovery failure", async () => {
  const { provider, options } = createFamilyFixture();
  const reason = new Error("publication failed");
  const onHost = vi.fn(() => {
    throw reason;
  });

  await expect(provider.list({ onHost })).rejects.toBe(reason);

  expect(onHost).toHaveBeenCalledTimes(1);
  expect(options.runtime.nodes.list).not.toHaveBeenCalled();
});

it.each(["retirement", "publication failure"] as const)(
  "joins all started node work before rejecting on %s",
  async (failure) => {
    const { provider, options } = createFamilyFixture();
    const entered = createDeferred();
    const fast = createDeferred();
    const slow = createDeferred();
    const reason = new Error(failure);
    const controller = new AbortController();
    vi.mocked(options.runtime.nodes.list).mockResolvedValue({
      nodes: ["fast", "slow"].map((nodeId) => ({
        nodeId,
        connected: true,
        commands: ["family.list"],
      })),
    });
    let started = 0;
    vi.mocked(options.runtime.nodes.invoke).mockImplementation(async ({ nodeId }) => {
      if (++started === 2) {
        entered.resolve();
      }
      await (nodeId === "fast" ? fast.promise : slow.promise);
      return { payloadJSON: JSON.stringify({ sessions: [] }) };
    });
    const onHost = vi.fn((host: { hostId: string }) => {
      if (failure === "publication failure" && host.hostId === "node:fast") {
        throw reason;
      }
    });
    let settled = false;
    const pending = provider.list({
      hostIds: ["node:fast", "node:slow"],
      signal: controller.signal,
      onHost,
    });
    const markSettled = () => {
      settled = true;
    };
    void pending.then(markSettled, markSettled);
    try {
      await entered.promise;
      if (failure === "retirement") {
        controller.abort(reason);
      }
      fast.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      if (failure === "retirement") {
        expect(onHost).not.toHaveBeenCalled();
      }
      slow.resolve();
      await expect(pending).rejects.toBe(reason);
    } finally {
      fast.resolve();
      slow.resolve();
      await pending.catch(() => []);
    }
  },
);

it.each([
  { joinDuring: "lookup", firstAgentId: "main", secondAgentId: "other" },
  { joinDuring: "lookup", firstAgentId: undefined, secondAgentId: "main" },
  { joinDuring: "completion", firstAgentId: "main", secondAgentId: "main" },
])(
  "coordinates $firstAgentId/$secondAgentId adoption during $joinDuring and reuses stored adoption",
  async ({ joinDuring, firstAgentId, secondAgentId }) => {
    const { provider, options, create, complete } = createFamilyFixture();
    const request = { hostId: "gateway", threadId: "local-thread" };
    const sourceKey = sessionCatalogAdoptedSourceKey(request.hostId, request.threadId);
    const adopted = new Map<string, Map<string, string>>();
    const { entered, release, pause } = barrier();
    const secondResolved = createDeferred();
    let resolutions = 0;
    options.continuation.resolveAgentId = (agentId = "main") => {
      if (++resolutions === 2) {
        secondResolved.resolve();
      }
      return agentId;
    };
    const listAdopted = vi.fn(async (agentId = "main") => {
      if (joinDuring === "lookup") {
        await pause();
      }
      return adopted.get(agentId) ?? new Map<string, string>();
    });
    options.continuation.listAdopted = listAdopted;
    create.mockImplementation(async ({ agentId }) => {
      const sessionKey = `agent:${agentId}:created`;
      adopted.set(agentId, new Map([[sourceKey, sessionKey]]));
      return { sessionKey };
    });
    complete.mockImplementation(async (continued) => {
      if (joinDuring === "completion") {
        await pause();
      }
      return continued;
    });

    const first = provider.continueSession({ ...request, agentId: firstAgentId });
    await entered.promise;
    const second = provider.continueSession({ ...request, agentId: secondAgentId });
    // Resolution is synchronous; the second request enters single-flight before this resumes.
    await secondResolved.promise;
    release.resolve();
    const results = await Promise.all([first, second]);

    expect
      .soft(results)
      .toEqual([
        { sessionKey: "agent:main:created" },
        { sessionKey: `agent:${secondAgentId}:created` },
      ]);
    const agentIds = [...new Set(["main", secondAgentId])];
    expect.soft(listAdopted.mock.calls).toEqual(agentIds.map((agentId) => [agentId]));
    expect.soft(create).toHaveBeenCalledTimes(agentIds.length);
    expect.soft(complete).toHaveBeenCalledTimes(agentIds.length);
    for (const agentId of agentIds) {
      const continued = { sessionKey: `agent:${agentId}:created` };
      expect.soft(create).toHaveBeenCalledWith({
        ...request,
        agentId,
        session: session(request.threadId),
      });
      expect.soft(complete).toHaveBeenCalledWith(continued, request.threadId);
      // Stored source identity stays host/thread-only after the in-flight operation ends.
      await expect(provider.continueSession({ ...request, agentId })).resolves.toEqual(continued);
    }
    expect(create).toHaveBeenCalledTimes(agentIds.length);
    expect(complete).toHaveBeenCalledTimes(agentIds.length * 2);
  },
);
