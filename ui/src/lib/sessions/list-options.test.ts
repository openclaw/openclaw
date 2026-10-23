import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionGoal, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

function fixture(
  request: (method: string, params?: unknown) => Promise<unknown>,
  key: string,
  ownerId?: string,
  agentId = "main",
) {
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient, undefined, {
    selfUser: ownerId ? { id: ownerId } : null,
  });
  Object.assign(harness.gateway.snapshot, { sessionKey: key, assistantAgentId: agentId });
  return { ...harness, sessions: createTestSessionCapability(harness.gateway, agentId) };
}

function sessionRow(
  key: string,
  sessionId: string,
  updatedAt: number,
  fields?: Partial<GatewaySessionRow>,
) {
  return { key, kind: "direct" as const, sessionId, updatedAt, ...fields };
}

const foregroundOptions = { agentId: "main", force: true } as const;
const enrichedOptions = { ...foregroundOptions, includeDerivedTitles: true };

function listRequest(read?: (call: number, params?: unknown) => unknown, patch?: () => unknown) {
  let calls = 0;
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.list" && read) {
      return read(++calls, params);
    }
    if (method === "sessions.patch" && patch) {
      return patch();
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}

function archiveReceipt(key: string, sessionId: string, updatedAt: number) {
  const entry = { sessionId, archivedAt: updatedAt, updatedAt };
  return { ok: true, key, path: "(multiple)", entry };
}

function modelHarness(twoRequests = false) {
  const key = "global";
  const pending = createDeferred<unknown>();
  const replacement = createDeferred<unknown>();
  let calls = 0;
  const { sessions } = fixture(
    listRequest(undefined, () =>
      ++calls === 1 || !twoRequests ? pending.promise : replacement.promise,
    ),
    key,
  );
  const patch = (model: string, ownsModelOverride?: () => boolean) =>
    sessions.patch(
      key,
      { model },
      {
        deferListRefresh: true,
        ...(ownsModelOverride ? { ownsModelOverride } : {}),
      },
    );
  return { key, sessions, pending, replacement, patch };
}

async function settleModelPatch(
  pending: ReturnType<typeof createDeferred<unknown>>,
  operation: Promise<unknown>,
  outcome: "resolve" | "reject",
  message = "agent A patch failed",
) {
  if (outcome === "resolve") {
    pending.resolve({ ok: true, path: "", key: "global", entry: {} });
    await expect(operation).resolves.toMatchObject({ ok: true, key: "global" });
  } else {
    pending.reject(new Error(message));
    await expect(operation).rejects.toThrow(message);
  }
}

it("keeps an explicit involving-me query single-phase", async () => {
  const options = { involvingMe: true };
  const request = listRequest(() => sessionsResult([], 1));
  const { sessions } = fixture(request, "agent:main:main", "profile-ada");

  await sessions.refresh({ agentId: "main", ...options, force: true });

  const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
  expect(listCalls).toHaveLength(1);
  expect(listCalls[0]?.[1]).toEqual(expect.objectContaining(options));
});

it("keeps derived titles when a foreground refresh queues behind an archive replacement", async () => {
  const key = "agent:main:untitled";
  const titled = sessionRow(key, "title-session", 1, {
    label: key,
    derivedTitle: "Readable planning title",
  });
  const archiveReplacementStarted = createDeferred();
  const archiveReplacement = createDeferred<SessionsListResult>();
  const request = listRequest(
    (call, params) => {
      if (call === 2) {
        archiveReplacementStarted.resolve();
        return archiveReplacement.promise;
      }
      return sessionsResult(
        [
          sessionRow(key, "title-session", 1, {
            label: key,
            ...(asOptionalRecord(params)?.includeDerivedTitles === true
              ? { derivedTitle: titled.derivedTitle }
              : {}),
          }),
        ],
        1,
      );
    },
    () => archiveReceipt(key, "title-session", 2),
  );
  const { sessions } = fixture(request, key);

  await sessions.refresh(enrichedOptions);
  let observedArchive = false;
  let archiveReverted = false;
  const stop = sessions.subscribe((state) => {
    const archived = state.result?.sessions.find((row) => row.key === key)?.archived;
    observedArchive ||= archived === true;
    archiveReverted ||= observedArchive && archived === false;
  });
  const archive = sessions.patch(key, { archived: true }, { agentId: "main" });
  await archiveReplacementStarted.promise;
  const foreground = sessions.refresh(foregroundOptions);
  archiveReplacement.resolve(sessionsResult([titled], 1));
  await Promise.all([archive, foreground]);

  const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
  expect(listCalls).toHaveLength(3);
  expect(listCalls[1]?.[1]).toMatchObject({ agentId: "main", includeDerivedTitles: true });
  expect(listCalls[2]?.[1]).toMatchObject({ agentId: "main", includeDerivedTitles: true });
  expect(sessions.state.result?.sessions[0]?.derivedTitle).toBe("Readable planning title");
  expect(sessions.state.result?.sessions[0]?.archived).toBe(true);
  expect(archiveReverted).toBe(false);
  stop();
});

it("retains the routed archived descriptor through its foreground replacement", async () => {
  const key = "agent:main:dashboard:archived";
  const request = listRequest(
    (call) =>
      sessionsResult(
        call === 1
          ? [sessionRow(key, "archived-session", 1, { derivedTitle: "Readable archived title" })]
          : [{ key: "agent:main:main", kind: "direct", updatedAt: 2 }],
        call,
      ),
    () => archiveReceipt(key, "archived-session", 2),
  );
  const { sessions } = fixture(request, key);

  await sessions.refresh(enrichedOptions);
  const titleHistory: Array<string | undefined> = [];
  const stop = sessions.subscribe((state) => {
    titleHistory.push(state.result?.sessions.find((row) => row.key === key)?.derivedTitle);
  });

  await sessions.patch(key, { archived: true }, { agentId: "main" });

  expect(titleHistory).not.toContain(undefined);
  expect(sessions.state.result?.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key, archived: true, derivedTitle: "Readable archived title" }),
    ]),
  );
  stop();
});

it("retains confirmed archive state after the routed row is evicted", async () => {
  const key = "agent:main:dashboard:archived";
  const otherKey = "agent:main:dashboard:other";
  const request = listRequest(
    (call) => {
      const other = { key: otherKey, kind: "direct" as const, updatedAt: 30 };
      return sessionsResult(
        call === 3
          ? [other]
          : [sessionRow(key, "archived-session", 10, { archived: false }), other],
        call,
      );
    },
    () => archiveReceipt(key, "archived-session", 20),
  );
  const { sessions, gateway, emitEvent } = fixture(request, key);

  await sessions.refresh(foregroundOptions);
  await sessions.patch(key, { archived: true }, { agentId: "main" });
  gateway.snapshot.sessionKey = otherKey;
  await sessions.refresh(foregroundOptions);
  expect(sessions.state.result?.sessions.some((row) => row.key === key)).toBe(false);

  await sessions.refresh(foregroundOptions);
  expect(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
    archived: true,
    archivedAt: 20,
  });

  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      key,
      kind: "direct",
      sessionId: "archived-session",
      updatedAt: 50,
      archived: false,
      archivedAt: null,
      reason: "update",
    },
  });
  expect(sessions.state.result?.sessions.find((row) => row.key === key)?.archived).toBe(false);
});

it.each(["before", "after"] as const)(
  "preserves a replacement session observed %s archive acknowledgement",
  async (replacementTiming) => {
    const key = "agent:main:dashboard:replaced";
    const confirmation = archiveReceipt(key, "archived-session", 20);
    const response = createDeferred<typeof confirmation>();
    let failRefresh = false;
    const snapshots: GatewaySessionRow[] = [
      { key, kind: "direct", sessionId: "archived-session", updatedAt: 10 },
      { key, kind: "direct", updatedAt: 30, archived: false },
      { key, kind: "direct", sessionId: "replacement-session", updatedAt: 40, archived: false },
    ];
    const request = listRequest(
      (call) => {
        if (failRefresh) {
          throw new Error("Archive list refresh unavailable");
        }
        return sessionsResult(
          [snapshots[call - 1] ?? { key, kind: "direct", updatedAt: 50, archived: false }],
          call,
        );
      },
      () => response.promise,
    );
    const { sessions } = fixture(request, key);
    let archive: Promise<unknown> | undefined;
    try {
      await sessions.refresh(foregroundOptions);
      archive = sessions.patch(
        key,
        { archived: true },
        { agentId: "main", expectedSessionId: "archived-session" },
      );
      if (replacementTiming === "before") {
        await sessions.refresh(foregroundOptions);
        await sessions.refresh(foregroundOptions);
        expect(sessions.state.result?.sessions[0]?.sessionId).toBe("replacement-session");
        failRefresh = true;
      }
      response.resolve(confirmation);
      await archive;
      if (replacementTiming === "before") {
        expect(sessions.state.result?.sessions[0]).toMatchObject({
          sessionId: "replacement-session",
          updatedAt: 40,
          archived: false,
        });
        expect(sessions.archiveVisibility(key)).toBeUndefined();
        expect(sessions.state.error).toContain("Archive list refresh unavailable");
        return;
      }
      expect(sessions.state.result?.sessions[0]).toMatchObject({ archived: false });
      expect(sessions.state.result?.sessions[0]?.sessionId).toBeUndefined();
      expect(sessions.archiveVisibility(key)).toBeUndefined();

      await sessions.refresh(foregroundOptions);
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: "replacement-session",
        archived: false,
      });
      expect(sessions.archiveVisibility(key)).toBeUndefined();

      await sessions.refresh(foregroundOptions);
      expect(sessions.state.result?.sessions[0]?.archived).toBe(false);
    } finally {
      sessions.dispose();
      response.resolve(confirmation);
      await archive;
    }
  },
);

it("restores Active membership when an archive and restore share a timestamp", async () => {
  vi.useFakeTimers();
  const original: GatewaySessionRow = {
    key: "agent:main:restored-archive",
    agentId: "main",
    sessionId: "restored-archive",
    kind: "direct",
    updatedAt: 10,
    archived: false,
  };
  let offered = original;
  const client = createTestGatewayClient(async (method) => {
    if (method === "sessions.list") {
      return sessionsResult([offered], offered.updatedAt ?? 0);
    }
    if (method === "sessions.patch") {
      return {
        ok: true,
        path: "(multiple)",
        key: original.key,
        entry: { sessionId: original.sessionId, updatedAt: 20 },
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const archived = {
    ...original,
    sessionKey: original.key,
    reason: "archive",
    updatedAt: 20,
    archived: true,
    archivedAt: 20,
  };
  try {
    await sessions.refresh(foregroundOptions);
    emitEvent({ type: "event", event: "sessions.changed", payload: archived });
    expect(sessions.state.result?.sessions).toEqual([]);
    expect(sessions.archiveVisibility(original.key)).toBe("archived");

    offered = { ...original, updatedAt: 20 };
    await sessions.patch(
      original.key,
      { archived: false },
      { agentId: "main", expectedSessionId: original.sessionId, deferListRefresh: true },
    );
    await sessions.refresh(foregroundOptions);
    expect(sessions.state.result?.sessions).toEqual([offered]);

    expect(sessions.state.result?.count).toBe(1);
    expect(sessions.archiveVisibility(original.key)).toBeUndefined();
  } finally {
    sessions.dispose();
    vi.useRealTimers();
  }
});

it.each(["primary", "managed"] as const)(
  "does not transfer an archive event to a replacement in the %s list",
  async (owner) => {
    vi.useFakeTimers();
    const selected: GatewaySessionRow = sessionRow("agent:main:main", "selected-session", 10);
    const original: GatewaySessionRow = sessionRow(
      "agent:main:archive-event",
      "archive-event-old",
      10,
      { label: "Archive event", archived: false },
    );
    const replacement = {
      ...original,
      sessionId: "archive-event-new",
      label: "Archive event replacement",
      updatedAt: 30,
    };
    let offered = original;
    const query = { agentId: "main", search: "Archive event", archivedFilter: "active" as const };
    const client = createTestGatewayClient(async (method, params) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const rows =
        owner === "primary"
          ? [selected, offered]
          : asOptionalRecord(params)?.search
            ? [offered]
            : [selected];
      return {
        ...sessionsResult(rows, offered.updatedAt ?? 0),
        totalCount: 4,
        hasMore: true,
        nextOffset: rows.length,
      };
    });
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    const updates = vi.fn();
    const stop =
      owner === "managed" ? sessions.subscribeList(query, updates) : sessions.subscribe(updates);
    const snapshot = () => (owner === "managed" ? sessions.listSnapshot(query) : sessions.state);
    const refresh = () =>
      owner === "managed"
        ? sessions.refreshList({ ...query, force: true })
        : sessions.refresh(foregroundOptions);
    try {
      await sessions.refresh(foregroundOptions);
      if (owner === "managed") {
        await refresh();
      }
      const primary = sessions.state.result;
      const offset = snapshot().result?.nextOffset;
      updates.mockClear();
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          ...original,
          sessionKey: original.key,
          agentId: "main",
          reason: "archive",
          updatedAt: 20,
          archived: true,
          archivedAt: 20,
          archiveReason: "Archived for the test",
        },
      });
      expect(snapshot().result?.sessions.some((row) => row.key === original.key)).toBe(false);
      expect(updates).toHaveBeenCalled();
      expect(sessions.archiveVisibility(original.key)).toBe("archived");
      expect(snapshot()).toMatchObject({ loading: false, error: null });
      expect(snapshot().result).toMatchObject({
        totalCount: 4,
        hasMore: true,
        nextOffset: offset,
      });

      offered = replacement;
      await refresh();
      expect(snapshot().result?.sessions.find((row) => row.key === original.key)).toEqual(
        replacement,
      );
      expect(sessions.archiveVisibility(original.key)).toBeUndefined();
      expect(sessions.state.result?.sessions.find((row) => row.key === selected.key)).toEqual(
        selected,
      );
      if (owner === "managed") {
        expect(sessions.state.result).toBe(primary);
      }
    } finally {
      stop();
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "preserves enrichment only within the same session (reset: %s)",
  async (reset) => {
    const key = reset ? "agent:main:dashboard:session" : "agent:main:dashboard:session-1";
    const enrichment = reset
      ? { derivedTitle: "Previous session title" }
      : {
          derivedTitle: "Readable planning title",
          lastMessagePreview: "Latest visible reply",
        };
    const request = listRequest((call) =>
      sessionsResult(
        [
          sessionRow(
            key,
            reset ? `session-${call}` : "session-1",
            call,
            call === 1 ? enrichment : {},
          ),
        ],
        call,
      ),
    );
    const { sessions } = fixture(request, key);
    await sessions.refresh(enrichedOptions);
    await sessions.refresh(enrichedOptions);
    expect(sessions.state.result?.sessions[0]).toMatchObject(
      reset ? { key, sessionId: "session-2", updatedAt: 2 } : { key, updatedAt: 2, ...enrichment },
    );
    if (reset) {
      expect(sessions.state.result?.sessions[0]?.derivedTitle).toBeUndefined();
    }
  },
);

it("does not preserve another agent's raw-global row through background hydration", async () => {
  const opsGoal: SessionGoal = {
    schemaVersion: 1,
    id: "goal-ops",
    objective: "Ops only",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  const request = listRequest((listCallCount) => {
    return sessionsResult(
      listCallCount === 1
        ? [
            {
              key: "global",
              kind: "global",
              updatedAt: 1,
              owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
              goal: opsGoal,
              status: "running",
            },
          ]
        : [],
      listCallCount,
    );
  });
  const { sessions, gateway } = fixture(request, "global", undefined, "ops");

  await sessions.refresh({ agentId: "ops", force: true });
  expect(sessions.state.result?.sessions[0]).toMatchObject({ key: "global", goal: opsGoal });

  gateway.snapshot.assistantAgentId = "research";
  await sessions.refresh({ agentId: "research", backgroundHydrate: true, force: true });

  expect(sessions.state.agentId).toBe("research");
  expect(sessions.state.result?.sessions).toEqual([]);
});

it("captures foreground list options before concurrent mutation refreshes", async () => {
  const key = "agent:main:concurrent";
  const firstList = createDeferred<SessionsListResult>();
  const request = listRequest(
    (call) =>
      call === 1 ? firstList.promise : sessionsResult([{ key, kind: "direct", updatedAt: 2 }], 1),
    () => ({ ok: true }),
  );
  const { sessions } = fixture(request, key);

  const foreground = sessions.refresh({
    agentId: "main",
    search: "concurrent",
    limit: 30,
    includeDerivedTitles: true,
    force: true,
  });
  const mutation = sessions.patch(key, { pinned: true }, { agentId: "main" });
  firstList.resolve(sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1));
  await Promise.all([foreground, mutation]);

  const sessionLists = request.mock.calls.filter(([method]) => method === "sessions.list");
  expect(sessionLists).toHaveLength(2);
  expect(sessionLists[1]?.[1]).toMatchObject({
    agentId: "main",
    search: "concurrent",
    limit: 30,
    includeDerivedTitles: true,
  });
});

it("drops pagination while preserving filters when refreshing after session patches", async () => {
  const key = "agent:main:page-b";
  const request = listRequest(
    () =>
      sessionsResult(
        [
          {
            key,
            kind: "direct",
            updatedAt: 2,
            label: key,
            derivedTitle: "Readable second-page title",
          },
        ],
        2,
      ),
    () => ({ ok: true }),
  );
  const { sessions } = fixture(request, key);

  const baseListOptions = {
    agentId: "main",
    activeMinutes: 0,
    limit: 1,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
    includeLastMessage: true,
    force: true,
  };
  await sessions.refresh(baseListOptions);
  await sessions.refresh({ ...baseListOptions, offset: 1, append: true });
  await sessions.patch(key, { unread: false }, { agentId: "main" });

  const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
  expect(listCalls).toHaveLength(3);
  expect(listCalls[2]?.[1]).toMatchObject({
    agentId: "main",
    limit: 1,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
    includeLastMessage: true,
  });
  expect(listCalls[2]?.[1]).not.toHaveProperty("append");
  expect(listCalls[2]?.[1]).not.toHaveProperty("offset");
});

it.each([
  ["before", "resolve"],
  ["after", "resolve"],
  ["after", "reject"],
] as const)(
  "retires a model claim when its owner changes %s admission and the request %s",
  async (timing, outcome) => {
    const { key, sessions, pending, patch } = modelHarness();
    let ownsModelOverride = timing !== "before";
    const model = timing === "before" ? "openai/gpt-new" : "openai/gpt-agent-a";
    const operation = patch(model, () => ownsModelOverride);
    expect(sessions.state.modelOverrides[key]).toBe(timing === "before" ? undefined : model);
    ownsModelOverride = false;
    await settleModelPatch(pending, operation, outcome);
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    if (timing === "after") {
      expect(sessions.state.error).toBeNull();
    }
  },
);

it.each([
  ["resolve", false],
  ["reject", false],
  ["resolve", true],
  ["reject", true],
] as const)(
  "preserves a newer equal-value model claim when an older request %s (owner active: %s)",
  async (outcome, ownerActive) => {
    const { key, sessions, pending, replacement, patch } = modelHarness(true);
    let ownsModelOverride = true;
    const operation = patch("openai/gpt-shared", () => ownsModelOverride);
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-shared");
    ownsModelOverride = ownerActive;
    const newer = patch("openai/gpt-shared");
    await settleModelPatch(pending, operation, outcome);
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-shared");
    expect(sessions.state.error).toBe(
      ownerActive && outcome === "reject" ? "agent A patch failed" : null,
    );
    replacement.resolve({ ok: true, key, entry: {} });
    await newer;
  },
);

it("does not reuse a retired owner's model baseline for the next owner", async () => {
  const { key, sessions, pending, replacement, patch } = modelHarness(true);
  const agentAOperation = patch("openai/gpt-agent-a-new");
  expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-agent-a-new");
  sessions.retireModelOverride(key);
  expect(sessions.state.modelOverrides[key]).toBeUndefined();
  const agentBOperation = patch("openai/gpt-agent-b");
  expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-agent-b");
  await settleModelPatch(replacement, agentBOperation, "reject", "agent B patch failed");
  expect(sessions.state.modelOverrides[key]).toBeUndefined();
  await settleModelPatch(pending, agentAOperation, "resolve");
  expect(sessions.state.modelOverrides[key]).toBeUndefined();
});
