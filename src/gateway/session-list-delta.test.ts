import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
  SessionsListParamsSchema,
  type SessionsListParams,
} from "../../packages/gateway-protocol/src/schema/sessions-list.js";
import {
  expandSessionRowFacts,
  SESSION_ROWS_DELTA_PREFIX,
} from "../../packages/gateway-protocol/src/session-row-fields.js";
import {
  buildSessionListParams,
  requestSessionListParams,
} from "../../ui/src/lib/sessions/session-requests.js";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunContext,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { listSessions, requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { getSessionListBaseMiss } from "./session-list-diagnostics.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { shareSidebarSessionRows } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

afterEach(() => vi.restoreAllMocks());

it("keeps unrelated sidebar views across session-ID-only run start, finish, abort and recovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const context = requestContext({
      ...rolePolicyConfig(),
      agents: { entries: { main: {}, other: {} } },
    });
    const client = roleClient("view", "run-reader");
    const other = roleClient("view", "run-owner");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    prepareGatewayRecipientProfile(other);
    for (const [index, name] of ["alias-a", "alias-b", "unrelated"].entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:${name}` },
        {
          sessionId: name === "unrelated" ? name : "run-session",
          updatedAt: now - index,
          lastActivityAt: now - index - 10,
          visibility: "shared",
          label: name,
          createdActor: {
            type: "human",
            source: "profile",
            id: (name === "unrelated" ? client : other).authenticatedUserProfile!.profileId,
          },
        },
      );
    }
    replaceSessionEntrySync(
      { agentId: "other", sessionKey: "agent:other:same-id" },
      { sessionId: "run-session", updatedAt: now, label: "Other agent", visibility: "shared" },
    );
    const primary = buildSessionListParams({
      agentId: "main",
      rowMode: "sidebar",
      source: "sidebar",
      includeDerivedTitles: true,
      includeLastMessage: true,
      ownerFirst: true,
    });
    const personal = { ...primary, ownerFirst: undefined, involvingMe: true };
    const read = (request: SessionsListParams, base?: SessionsListResult) =>
      listSessions({
        context,
        client,
        acceptsSerializedJson: true,
        request: {
          ...request,
          ...(base ? { ifRowsRevision: `delta:${base.rowsRevision}` } : {}),
        },
      });
    const release = retainSessionListForegroundWork();
    try {
      const initial = await read(primary);
      const initialPersonal = await read(personal);
      const otherQuery = { ...primary, agentId: "other" };
      const initialOther = await read(otherQuery);
      expect(initialOther.count).toBe(1);
      expect(
        expandSessionRowFacts(initial.sessions, initial.sharedFacts).map((row) => row.key),
      ).toEqual(["agent:main:unrelated", "agent:main:alias-a", "agent:main:alias-b"]);
      expect(initialPersonal.count).toBe(1);
      const changes = vi.fn();
      getSessionRowProjection(context)!.onFactsChange(changes);
      for (const ending of ["finish", "abort", "restart"] as const) {
        changes.mockClear();
        const claim = claimAgentRunContext(
          "sidebar-run",
          { agentId: "MAIN", sessionId: "run-session", projectSessionActive: true },
          { trackOwner: true, ownsContext: true },
        );
        expect(changes.mock.calls).toEqual([
          [{ kind: "row", key: "agent:main:alias-a" }],
          [{ kind: "row", key: "agent:main:alias-b" }],
        ]);
        const active = await read(primary, initial);
        expect(active.rowsDelta).toEqual({ baseRevision: initial.rowsRevision, order: [0, 3, 4] });
        expect(expandSessionRowFacts(active.sessions, active.sharedFacts)).toEqual([
          expect.objectContaining({
            key: "agent:main:alias-a",
            hasActiveRun: true,
            lastActivityAt: now - 10,
          }),
          expect.objectContaining({
            key: "agent:main:alias-b",
            hasActiveRun: true,
            lastActivityAt: now - 11,
          }),
        ]);
        expect(await read(personal, initialPersonal)).toMatchObject({ rowsUnchanged: true });
        expect(await read(otherQuery, initialOther)).toMatchObject({ rowsUnchanged: true });
        if (ending === "restart") {
          rotateAgentRunRegistryLifecycleGeneration();
          expect(changes).toHaveBeenLastCalledWith({ kind: "reset" });
        } else {
          if (ending === "abort") {
            clearAgentRunContext("sidebar-run");
          }
          releaseAgentRunContext("sidebar-run", claim);
        }
        const settled = await read(primary);
        expect(expandSessionRowFacts(settled.sessions, settled.sharedFacts)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: "agent:main:alias-a",
              hasActiveRun: false,
              lastActivityAt: now - 10,
            }),
            expect.objectContaining({
              key: "agent:main:alias-b",
              hasActiveRun: false,
              lastActivityAt: now - 11,
            }),
          ]),
        );
      }
    } finally {
      clearAgentRunContext("sidebar-run");
      getSessionRowProjection(context)?.dispose();
      release();
    }
  });
});

it("encodes insertions, replacements, reorders and removals against an exact immutable base", () => {
  const a: GatewaySessionRow = {
    key: "global",
    agentId: "main",
    kind: "global",
    label: "A",
    updatedAt: 1,
  };
  const b: GatewaySessionRow = {
    ...a,
    agentId: "other",
    label: "B",
  };
  const c: GatewaySessionRow = { key: "c", kind: "direct", label: "C", updatedAt: 1 };
  const previous = [a, b, c];
  const first = shareSidebarSessionRows(previous);
  const revision = first.rowsRevision!;
  const changed = { ...a, label: "Changed" };
  const inserted: GatewaySessionRow = { key: "d", kind: "direct", label: "Inserted", updatedAt: 1 };
  const rows = [b, changed, inserted];
  const delta = shareSidebarSessionRows(rows, `${SESSION_ROWS_DELTA_PREFIX}${revision}`, [
    previous,
  ]);
  expect(delta.rowsDelta).toEqual({ baseRevision: revision, order: [1, 3, 4] });
  const wire = JSON.parse(
    serializeGatewayFrame({ type: "res", id: "list", ok: true, payload: delta }).toString(),
  ).payload;
  expect(expandSessionRowFacts(wire.sessions, wire.sharedFacts)).toEqual([changed, inserted]);
  const reordered = shareSidebarSessionRows([b, a], `${SESSION_ROWS_DELTA_PREFIX}${revision}`, [
    previous,
  ]);
  expect(reordered.sessions).toEqual([]);
  expect(reordered.rowsDelta).toEqual({ baseRevision: revision, order: [1, 0] });
  for (const token of [revision, `${SESSION_ROWS_DELTA_PREFIX}missing`]) {
    const full = shareSidebarSessionRows(rows, token, [previous]);
    expect(full.rowsDelta).toBeUndefined();
    expect(getSessionListBaseMiss(full)).toBe("unknown-base");
    expect(expandSessionRowFacts(full.sessions, full.sharedFacts)).toEqual(rows);
  }
  expect(
    shareSidebarSessionRows(rows, `${SESSION_ROWS_DELTA_PREFIX}${delta.rowsRevision}`),
  ).toEqual({
    sessions: [],
    rowsRevision: delta.rowsRevision,
    rowsUnchanged: true,
  });
  const allChanged = shareSidebarSessionRows([changed], `${SESSION_ROWS_DELTA_PREFIX}${revision}`, [
    previous,
  ]);
  expect(allChanged.rowsDelta).toBeUndefined();
  expect(getSessionListBaseMiss(allChanged)).toBe("all-rows-changed");
  expect(getSessionListBaseMiss(shareSidebarSessionRows([changed]))).toBeUndefined();
});

it("keeps deltas inside the authorized owner, personal and paginated list owners", async () => {
  const now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const context = requestContext(rolePolicyConfig());
    const client = roleClient("view", "delta-reader");
    const other = roleClient("view", "delta-other");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    prepareGatewayRecipientProfile(other);
    const viewer = client.authenticatedUserProfile!.profileId;
    const creator = {
      type: "human" as const,
      source: "profile" as const,
      id: other.authenticatedUserProfile!.profileId,
    };
    const key = (id: string) => `agent:main:delta-${id}`;
    const scope = (id: string) => ({ agentId: "main", sessionKey: key(id) });
    const write = (
      id: string,
      updatedAt: number,
      extra: { archivedAt?: number; visibility?: "draft" } = {},
    ) =>
      replaceSessionEntrySync(scope(id), {
        sessionId: id,
        updatedAt,
        label: id.toUpperCase(),
        visibility: "shared",
        createdActor: creator,
        ...extra,
      });
    for (const [index, id] of ["a", "b", "c", "d", "e"].entries()) {
      write(id, now - index);
    }
    assignSessionOwner(scope("e"), { owner: { type: "human", id: viewer }, assignedBy: creator });
    for (const id of ["a", "c"]) {
      recordSessionParticipant(scope(id), {
        identity: { type: "profile", id: viewer },
        promptedAt: now,
      });
    }
    const primary = { agentId: "main", rowMode: "sidebar", limit: 2, ownerFirst: true } as const;
    const personal = { agentId: "main", rowMode: "sidebar", limit: 2, involvingMe: true } as const;
    const owned = { agentId: "main", rowMode: "sidebar", limit: 2, ownerId: viewer } as const;
    const page = { ...primary, offset: 2 };
    const read = (request: SessionsListParams, base?: SessionsListResult, recipient = client) =>
      listSessions({
        context,
        client: recipient,
        acceptsSerializedJson: true,
        request: {
          ...request,
          ...(base ? { ifRowsRevision: `${SESSION_ROWS_DELTA_PREFIX}${base.rowsRevision}` } : {}),
        },
      });
    const changedKeys = (result: SessionsListResult) =>
      expandSessionRowFacts(result.sessions, result.sharedFacts).map((row) => row.key);
    const expectDelta = (
      result: SessionsListResult,
      base: SessionsListResult,
      order: number[],
      keys: string[],
    ) => {
      expect(result.rowsDelta).toEqual({ baseRevision: base.rowsRevision, order });
      expect(changedKeys(result)).toEqual(keys.map(key));
    };
    const release = retainSessionListForegroundWork();
    try {
      const initial = await read(primary);
      const initialPersonal = await read(personal);
      const initialOwned = await read(owned);
      const initialPage = await read(page);
      const wireRequest = vi.fn((_method: string, request?: unknown) =>
        read(Value.Decode(SessionsListParamsSchema, request)),
      );
      const wireClient = createTestGatewayClient(wireRequest);
      await requestSessionListParams(wireClient, primary, () => true);
      expect(changedKeys(initial)).toEqual([key("e"), key("a"), key("b")]);
      expect(changedKeys(initialPersonal)).toEqual([key("a"), key("c")]);
      expect(changedKeys(initialOwned)).toEqual([key("e")]);
      expect(changedKeys(initialPage)).toEqual([key("c"), key("d")]);

      write("f", now + 1);
      recordSessionParticipant(scope("f"), {
        identity: { type: "profile", id: viewer },
        promptedAt: now + 1,
      });
      const inserted = await read(primary, initial);
      expect(inserted).toMatchObject({
        count: 3,
        totalCount: 6,
        limitApplied: 2,
        nextOffset: 2,
        hasMore: true,
        rowsDelta: { baseRevision: initial.rowsRevision, order: [0, 3, 1] },
      });
      expect(changedKeys(inserted)).toEqual([key("f")]);
      const involved = await read(personal, initialPersonal);
      expectDelta(involved, initialPersonal, [2, 0], ["f"]);
      const shifted = await read(page, initialPage);
      expect(shifted).toMatchObject({ count: 2, nextOffset: 4, rowsDelta: { order: [2, 0] } });
      expect(changedKeys(shifted)).toEqual([key("b")]);

      write("f", now + 2, { archivedAt: now + 2 });
      const removed = await read(primary, inserted);
      expectDelta(removed, inserted, [0, 2, 3], ["b"]);
      const refilled = await read(personal, involved);
      expect(refilled.rowsDelta).toEqual({ baseRevision: involved.rowsRevision, order: [1, 2] });
      expect(changedKeys(refilled)).toEqual([key("c")]);
      replaceSessionEntrySync(scope("b"), { ...loadSessionEntry(scope("b"))!, label: "Renamed" });
      await read(primary, removed);
      const olderBase = await read(primary, initial);
      expect(olderBase.rowsDelta).toEqual({
        baseRevision: initial.rowsRevision,
        order: [0, 1, 3],
      });
      expect(changedKeys(olderBase)).toEqual([key("b")]);
      const applied = await requestSessionListParams(wireClient, primary, () => true);
      expect(wireRequest).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({ ifRowsRevision: `delta:${initial.rowsRevision}` }),
      );
      const full = await read(primary);
      expect(applied?.sessions).toEqual(expandSessionRowFacts(full.sessions, full.sharedFacts));
      const differentLimit = await read({ ...primary, limit: 1 }, removed);
      expect(differentLimit.rowsDelta).toBeUndefined();
      expect(getSessionListBaseMiss(differentLimit)).toBe("unknown-base");
      expect(differentLimit.count).toBe(2);

      assignSessionOwner(scope("a"), { owner: { type: "human", id: viewer }, assignedBy: creator });
      const ownerChanged = await read(owned, initialOwned);
      expectDelta(ownerChanged, initialOwned, [1, 0], ["a"]);
      // Revoke a formerly visible row; current selection must omit it before encoding a delta.
      const beforeRevocation = await read({ ...primary, ownerFirst: false });
      write("b", now - 1, { visibility: "draft" });
      const revoked = await read({ ...primary, ownerFirst: false }, beforeRevocation);
      expectDelta(revoked, beforeRevocation, [0, 2], ["c"]);
      replaceSessionEntrySync(scope("a"), {
        ...loadSessionEntry(scope("a"))!,
        profileInvolvement: {
          key: key("a"),
          profiles: { [viewer]: { hidden: true, updatedAt: now + 3 } },
        },
      });
      const hidden = await read(personal, refilled);
      expectDelta(hidden, refilled, [1, 2], ["e"]);
      sessionChanges.emit({ all: true, scope: "config-profiles" });
      const reset = await read(personal, hidden);
      expect(reset.rowsDelta).toBeUndefined();
      expect(changedKeys(reset)).toEqual([key("c"), key("e")]);
      const otherViewer = await read(primary, removed, other);
      expect(otherViewer.rowsDelta).toBeUndefined();
      expect(changedKeys(otherViewer)).not.toContain(key("f"));

      const retained = await read(primary);
      for (let generation = 0; generation < 33; generation++) {
        replaceSessionEntrySync(scope("e"), {
          ...loadSessionEntry(scope("e"))!,
          label: `Generation ${generation}`,
        });
        const next = await read(primary, retained);
        if (generation === 31) {
          expect(next.rowsDelta?.baseRevision).toBe(retained.rowsRevision);
          expect(changedKeys(next)).toEqual([key("e")]);
        }
      }
      const evicted = await read(primary, retained);
      expect(evicted.rowsDelta).toBeUndefined();
      expect(changedKeys(evicted)).toEqual(changedKeys(await read(primary)));
    } finally {
      getSessionRowProjection(context)?.dispose();
      release();
    }
  });
});
