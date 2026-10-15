import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/schema/sessions-list.js";
import {
  expandSessionRowFacts,
  SESSION_ROWS_DELTA_PREFIX,
} from "../../packages/gateway-protocol/src/session-row-fields.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { listSessions, requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { shareSidebarSessionRows } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

afterEach(() => vi.restoreAllMocks());

it("encodes insertions, replacements, reorders and removals against an exact immutable base", () => {
  const a: GatewaySessionRow = {
    key: "global",
    agentId: "main",
    kind: "global",
    label: "A",
    updatedAt: 1,
  };
  const b: GatewaySessionRow = {
    key: "global",
    agentId: "other",
    kind: "global",
    label: "B",
    updatedAt: 1,
  };
  const c: GatewaySessionRow = { key: "c", kind: "direct", label: "C", updatedAt: 1 };
  const previous = [a, b, c];
  const first = shareSidebarSessionRows(previous);
  const revision = first.rowsRevision!;
  const changed = { ...a, label: "Changed" };
  const inserted: GatewaySessionRow = { key: "d", kind: "direct", label: "Inserted", updatedAt: 1 };
  const rows = [b, changed, inserted];
  const delta = shareSidebarSessionRows(rows, `${SESSION_ROWS_DELTA_PREFIX}${revision}`, previous);
  expect(delta.rowsDelta).toEqual({ baseRevision: revision, order: [1, 3, 4] });
  const wire = JSON.parse(
    serializeGatewayFrame({ type: "res", id: "list", ok: true, payload: delta }).toString(),
  ).payload;
  expect(expandSessionRowFacts(wire.sessions, wire.sharedFacts)).toEqual([changed, inserted]);
  const reordered = shareSidebarSessionRows(
    [b, a],
    `${SESSION_ROWS_DELTA_PREFIX}${revision}`,
    previous,
  );
  expect(reordered.sessions).toEqual([]);
  expect(reordered.rowsDelta).toEqual({ baseRevision: revision, order: [1, 0] });
  for (const token of [revision, `${SESSION_ROWS_DELTA_PREFIX}missing`]) {
    const full = shareSidebarSessionRows(rows, token, previous);
    expect(full.rowsDelta).toBeUndefined();
    expect(expandSessionRowFacts(full.sessions, full.sharedFacts)).toEqual(rows);
  }
  expect(
    shareSidebarSessionRows(rows, `${SESSION_ROWS_DELTA_PREFIX}${delta.rowsRevision}`),
  ).toEqual({
    sessions: [],
    rowsRevision: delta.rowsRevision,
    rowsUnchanged: true,
  });
  expect(
    shareSidebarSessionRows([changed], `${SESSION_ROWS_DELTA_PREFIX}${revision}`, previous)
      .rowsDelta,
  ).toBeUndefined();
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
    const release = retainSessionListForegroundWork();
    try {
      const initial = await read(primary);
      const initialPersonal = await read(personal);
      const initialOwned = await read(owned);
      const initialPage = await read(page);
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
      expect(involved.rowsDelta).toEqual({
        baseRevision: initialPersonal.rowsRevision,
        order: [2, 0],
      });
      expect(changedKeys(involved)).toEqual([key("f")]);
      const shifted = await read(page, initialPage);
      expect(shifted).toMatchObject({ count: 2, nextOffset: 4, rowsDelta: { order: [2, 0] } });
      expect(changedKeys(shifted)).toEqual([key("b")]);

      write("f", now + 2, { archivedAt: now + 2 });
      const removed = await read(primary, inserted);
      expect(removed.rowsDelta).toEqual({ baseRevision: inserted.rowsRevision, order: [0, 2, 3] });
      expect(changedKeys(removed)).toEqual([key("b")]);
      const refilled = await read(personal, involved);
      expect(refilled.rowsDelta).toEqual({ baseRevision: involved.rowsRevision, order: [1, 2] });
      expect(changedKeys(refilled)).toEqual([key("c")]);
      const missed = await read(primary, initial);
      expect(missed.rowsDelta).toBeUndefined();
      expect(changedKeys(missed)).toEqual([key("e"), key("a"), key("b")]);
      const differentLimit = await read({ ...primary, limit: 1 }, removed);
      expect(differentLimit.rowsDelta).toBeUndefined();
      expect(differentLimit.count).toBe(2);

      assignSessionOwner(scope("a"), { owner: { type: "human", id: viewer }, assignedBy: creator });
      const ownerChanged = await read(owned, initialOwned);
      expect(ownerChanged.rowsDelta).toEqual({
        baseRevision: initialOwned.rowsRevision,
        order: [1, 0],
      });
      expect(changedKeys(ownerChanged)).toEqual([key("a")]);
      // Revoke a formerly visible row; current selection must omit it before encoding a delta.
      const beforeRevocation = await read({ ...primary, ownerFirst: false });
      write("b", now - 1, { visibility: "draft" });
      const revoked = await read({ ...primary, ownerFirst: false }, beforeRevocation);
      expect(revoked.rowsDelta).toEqual({
        baseRevision: beforeRevocation.rowsRevision,
        order: [0, 2],
      });
      expect(changedKeys(revoked)).toEqual([key("c")]);
      replaceSessionEntrySync(scope("a"), {
        ...loadSessionEntry(scope("a"))!,
        profileInvolvement: {
          key: key("a"),
          profiles: { [viewer]: { hidden: true, updatedAt: now + 3 } },
        },
      });
      const hidden = await read(personal, refilled);
      expect(hidden.rowsDelta).toEqual({ baseRevision: refilled.rowsRevision, order: [1, 2] });
      expect(changedKeys(hidden)).toEqual([key("e")]);
      sessionChanges.emit({ all: true, scope: "config-profiles" });
      const reset = await read(personal, hidden);
      expect(reset.rowsDelta).toBeUndefined();
      expect(changedKeys(reset)).toEqual([key("c"), key("e")]);
      const otherViewer = await read(primary, removed, other);
      expect(otherViewer.rowsDelta).toBeUndefined();
      expect(changedKeys(otherViewer)).not.toContain(key("f"));
    } finally {
      getSessionRowProjection(context)?.dispose();
      release();
    }
  });
});
