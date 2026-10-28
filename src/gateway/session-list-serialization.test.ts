import { afterEach, expect, it, vi } from "vitest";
import {
  expandSessionRowFacts,
  SESSION_ROW_DETAIL_FIELDS,
} from "../../packages/gateway-protocol/src/session-row-fields.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { normalizeBoardWidgetPutParams } from "../boards/board-store.js";
import {
  ensureBoardSchema,
  putBoardWidgetInDatabase,
} from "../boards/sqlite-board-store.kernel.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { registerRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { profileActor, writeListEntry } from "./session-list-entry.test-support.js";
import * as listFilters from "./session-list-filters.js";
import { withCurrentSessionListRows } from "./session-list-read-result.js";
import { beginSessionPermissionChange } from "./session-permission-change.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { shareSidebarSessionRows } from "./session-row-presentation.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

afterEach(() => vi.restoreAllMocks());

function readList(
  context: ReturnType<typeof requestContext>,
  client: ReturnType<typeof roleClient>,
  request: Parameters<typeof listSessions>[0]["request"],
  acceptsSerializedJson = true,
) {
  return listSessions({ context, client, request, acceptsSerializedJson });
}

function expectAbsent(row: unknown, fields: readonly string[]) {
  for (const field of fields) {
    expect(row).not.toHaveProperty(field);
  }
}

function wire(payload: unknown, id = "list") {
  return serializeGatewayFrame({ type: "res", id, ok: true, payload }).toString();
}

async function withListReader(
  id: string,
  run: (state: {
    context: ReturnType<typeof requestContext>;
    client: ReturnType<typeof roleClient>;
    cfg: ReturnType<typeof rolePolicyConfig>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    const context = requestContext(cfg);
    const client = roleClient("view", id);
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    await run({ context, client, cfg });
  });
}

function retainList(context: ReturnType<typeof requestContext>) {
  const release = retainSessionListForegroundWork();
  return {
    [Symbol.dispose]() {
      getSessionRowProjection(context)?.dispose();
      release();
    },
  };
}

it("packs equal fields by their recipient rows without changing the input or wire facts", () => {
  const sharedRow = (key: string, updatedAt: number, lastMessagePreview?: string) => ({
    key,
    kind: "direct" as const,
    updatedAt,
    label: "Shared",
    pinned: false,
    origin: { provider: "fixture" },
    lastMessagePreview,
  });
  const rows = [
    sharedRow("one", 1),
    sharedRow("two", 2, "Unique"),
    { key: "three", kind: "direct" as const, updatedAt: 3, label: "Other", pinned: false },
  ];
  const original = structuredClone(rows);
  const { rowsRevision, ...packed } = shareSidebarSessionRows(rows);
  const packedBytes = wire(packed);
  expect(rowsRevision).toEqual(expect.any(String));
  expect(shareSidebarSessionRows(rows).sessions).toBe(packed.sessions);
  expect(shareSidebarSessionRows(rows, rowsRevision)).toEqual({
    sessions: [],
    rowsRevision,
    rowsUnchanged: true,
  });
  expect(rows).toEqual(original);
  expect(expandSessionRowFacts(packed.sessions, packed.sharedFacts)).toEqual(original);
  // A changed page must not reuse the previous page's recipient groups or fact indexes.
  const changed = { ...rows[1]!, pinned: true, label: "Changed" };
  for (const page of [
    [rows[0]!, changed, rows[2]!],
    [rows[2]!, rows[0]!],
    [rows[0]!, rows[0]!],
    [...rows],
  ]) {
    const next = shareSidebarSessionRows(page);
    expect(expandSessionRowFacts(next.sessions, next.sharedFacts)).toEqual(page);
    expect(wire(packed)).toBe(packedBytes);
  }
  expect(packed.sharedFacts).toEqual([
    { label: "Shared", origin: { provider: "fixture" } },
    { pinned: false },
  ]);
  expect(packed.sessions.map((row) => row.sharedFacts)).toEqual([[0, 1], [0, 1], [1]]);
  for (const row of packed.sessions) {
    expectAbsent(row, row.key === "three" ? ["pinned"] : ["label", "origin", "pinned"]);
  }
});

it("reuses packed row bytes across sibling changes without retaining another viewer's layout", () => {
  const row = (key: string, label: string, sharingRole: "owner" | "viewer") =>
    Object.freeze({
      key,
      kind: "direct" as const,
      updatedAt: 1,
      rowMode: "sidebar" as const,
      label,
      visibility: "shared" as const,
      sharingRole,
    });
  const ownerRows = [row("a", "A", "owner"), row("b", "B", "owner"), row("c", "C", "owner")];
  const viewerRows = ownerRows.map((value) => row(value.key, value.label, "viewer"));
  const first = shareSidebarSessionRows(ownerRows);
  const viewer = shareSidebarSessionRows(viewerRows);
  expect(JSON.stringify(first.sessions)).toBe(
    '[{"key":"a","kind":"direct","updatedAt":1,"rowMode":"sidebar","label":"A","sharedFacts":[0]},{"key":"b","kind":"direct","updatedAt":1,"rowMode":"sidebar","label":"B","sharedFacts":[0]},{"key":"c","kind":"direct","updatedAt":1,"rowMode":"sidebar","label":"C","sharedFacts":[0]}]',
  );
  expect(first.sharedFacts).toEqual([{ visibility: "shared", sharingRole: "owner" }]);
  expect(viewer.sharedFacts).toEqual([{ visibility: "shared", sharingRole: "viewer" }]);
  using stringify = vi.spyOn(JSON, "stringify");
  const changed = shareSidebarSessionRows([row("a", "Changed", "owner"), ...ownerRows.slice(1)]);
  expect(changed.sessions[0]).not.toBe(first.sessions[0]);
  expect(changed.sessions[1]).toBe(first.sessions[1]);
  expect(changed.sessions[2]).toBe(first.sessions[2]);
  expect(
    stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "key" in value),
  ).toHaveLength(2);
  stringify.mockRestore();
  // A sibling joining a singleton fact changes the unchanged row's reference layout.
  const regrouped = shareSidebarSessionRows([row("a", "B", "owner"), ...ownerRows.slice(1)]);
  expect(regrouped.sessions[1]).not.toBe(first.sessions[1]);
  expect(regrouped.sharedFacts).toEqual([
    { label: "B" },
    { visibility: "shared", sharingRole: "owner" },
  ]);
  expect(regrouped.sessions[1]?.sharedFacts).toEqual([0, 1]);
  expect(shareSidebarSessionRows([...viewerRows]).sessions[1]).toBe(viewer.sessions[1]);
  shareSidebarSessionRows([...ownerRows]);
  using movedStringify = vi.spyOn(JSON, "stringify");
  const moved = shareSidebarSessionRows([
    row("d", "D", "owner"),
    row("e", "D", "owner"),
    ...ownerRows,
  ]);
  expect(moved.sessions[2]?.sharedFacts).toEqual([1]);
  expect(
    movedStringify.mock.calls.filter(
      ([value]) => value && typeof value === "object" && ["a", "b", "c"].includes(value.key),
    ),
  ).toHaveLength(0);
  movedStringify.mockRestore();
  expect(wire(moved)).toBe(JSON.stringify({ type: "res", id: "list", ok: true, payload: moved }));
  for (const payload of [first, viewer, changed, regrouped]) {
    const frame = { type: "res", id: "rows", ok: true, payload };
    expect(serializeGatewayFrame(frame).toString()).toBe(JSON.stringify(frame));
  }
});

it.each(["sidebar", "dashboard"] as const)(
  "keeps %s display facts while bounding the wire payload",
  (mode) =>
    withListReader(
      mode === "sidebar" ? "sidebar-reader" : "gallery-reader",
      async ({ context, client }) => {
        const sidebar = mode === "sidebar";
        const count = sidebar ? 8 : 2;
        const profiles = sidebar
          ? Array.from({ length: 4 }, (_, i) => ensureProfileForEmail(`sidebar-${i}@example.test`))
          : [];
        const label = (i: number) =>
          sidebar ? `Review the synthetic workspace change ${i}` : `Dashboard ${i}`;
        const id = (i: number) => (sidebar ? `synthetic-session-${i}` : `dashboard-${i}`);
        const key = (i: number) =>
          sidebar ? `agent:main:dashboard:${id(i)}` : `agent:main:${id(i)}`;
        if (!sidebar) {
          ensureBoardSchema(openOpenClawAgentDatabase({ agentId: "main" }));
        }
        for (let i = 0; i < count; i++) {
          const scope = { agentId: "main", sessionKey: key(i) };
          const actor = sidebar
            ? profileActor(profiles[0]!.id)
            : { type: "system" as const, label: "Synthetic author" };
          replaceSessionEntrySync(scope, {
            sessionId: id(i),
            updatedAt: 1_800_000_000_000 + i,
            label: label(i),
            visibility: "shared",
            modelProvider: "test-provider",
            model: "test-model",
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
            permissionMode: "full",
            createdActor: actor,
            ...(sidebar
              ? { createdAt: 1_800_000_000_000 + i }
              : {
                  boardFace: "dashboard" as const,
                  providerOverride: "test-provider",
                  modelOverride: "test-model",
                }),
          });
          if (sidebar) {
            assignSessionOwner(scope, {
              owner: { type: "human", id: profiles[i % profiles.length]!.id },
              assignedBy: profileActor(profiles[0]!.id),
              assignedAt: 1_800_000_000_000,
            });
            for (const profile of profiles) {
              recordSessionParticipant(scope, {
                identity: { type: "profile", id: profile.id },
                promptedAt: 1_800_000_000_000,
              });
            }
          } else {
            runOpenClawAgentWriteTransaction(
              (database) => {
                putBoardWidgetInDatabase(
                  database,
                  key(i),
                  normalizeBoardWidgetPutParams({
                    sessionKey: key(i),
                    name: "status",
                    content: { kind: "html", html: "<p>Ready</p>" },
                  }),
                  "synthetic-view",
                );
              },
              { agentId: "main" },
            );
          }
        }
        using _ = retainList(context);
        const read = (rowMode: "compact" | typeof mode) =>
          readList(context, client, {
            source: mode,
            rowMode,
            limit: sidebar ? 200 : count,
            agentId: "main",
            ...(!sidebar ? { hasBoard: true, archived: "all" as const, excludeDock: true } : {}),
          });
        const compact = await read("compact");
        const result = await read(mode);
        const rows = expandSessionRowFacts(result.sessions, result.sharedFacts);
        expect(result.sessions).toHaveLength(count);
        if (sidebar) {
          expect(rows[0]).toMatchObject({
            label: label(count - 1),
            owner: { actor: { id: profiles[(count - 1) % profiles.length]!.id } },
            participants: expect.arrayContaining(
              profiles
                .filter((_profile, i) => i !== (count - 1) % profiles.length)
                .map((profile) =>
                  expect.objectContaining({ identity: { type: "profile", id: profile.id } }),
                ),
            ),
          });
          for (const [i, row] of rows.entries()) {
            expect([row.createdActor, row.expandedParticipants]).toEqual([
              compact.sessions[i]!.createdActor,
              compact.sessions[i]!.expandedParticipants,
            ]);
            expectAbsent(row, ["model", "totalTokens", "sharedFacts"]);
          }
          expect(result.sessions[0]).not.toHaveProperty("createdActor");
          expect(result.sharedFacts).toBeDefined();
          const frame = JSON.parse(wire(result));
          expect(frame.payload).not.toHaveProperty("rowsFullReason");
          expect(
            JSON.stringify(
              expandSessionRowFacts(frame.payload.sessions, frame.payload.sharedFacts),
            ),
          ).toBe(JSON.stringify(rows));
          expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
            Buffer.byteLength(JSON.stringify(compact)) * 0.5,
          );
        } else {
          expect(result.sessions[0]).toMatchObject({
            key: key(count - 1),
            sessionId: id(count - 1),
            rowMode: "dashboard",
            label: label(count - 1),
            createdActor: { type: "system" },
            boardFace: "dashboard",
            hasBoard: true,
          });
          expectAbsent(result.sessions[0], [
            "model",
            "modelProvider",
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "permissionMode",
            "participants",
          ]);
          expect(compact.sessions[0]).toMatchObject({
            model: "test-model",
            totalTokens: 1500,
            permissionMode: "full",
          });
          expect((await read("compact")).sessions).toEqual(compact.sessions);
          expect(Buffer.byteLength(wire(result, "gallery"))).toBeLessThan(
            Buffer.byteLength(wire(compact, "gallery")) * 0.75,
          );
        }
      },
    ),
);

it("keeps a sidebar page revision across off-page facts and replaces it for selected facts", () =>
  withListReader("page-reader", async ({ context, client }) => {
    const keys = ["agent:main:off-page", "agent:main:selected-page"];
    for (const [index, sessionKey] of keys.entries()) {
      writeListEntry(sessionKey, {
        sessionId: sessionKey,
        updatedAt: index + 1,
        visibility: "shared",
      });
    }
    using _ = retainList(context);
    const read = (ifRowsRevision?: string) =>
      readList(context, client, { rowMode: "sidebar", limit: 1, ifRowsRevision });
    const first = await read();
    expect(first.sessions.map((row) => row.key)).toEqual([keys[1]]);
    sessionChanges.emit({ sessionKey: keys[0]!, scope: "runtime" });
    const unchanged = await read(first.rowsRevision);
    expect(unchanged).toMatchObject({
      rowsRevision: first.rowsRevision,
      rowsUnchanged: true,
      sessions: [],
    });
    sessionChanges.emit({ sessionKey: keys[1]!, scope: "runtime" });
    const changed = await read(first.rowsRevision);
    expect(changed.rowsRevision).not.toBe(first.rowsRevision);
    expect(changed.rowsUnchanged).toBeUndefined();
    expect(changed.sessions.map((row) => row.key)).toEqual([keys[1]]);
  }));

it("coalesces cold sidebar selection across row slices only for the same principal and filter", () =>
  withListReader("cold-alice", async ({ context, client: alice }) => {
    const bob = roleClient("view", "cold-bob");
    prepareGatewayRecipientProfile(bob);
    const rows = 130;
    for (let index = 0; index < rows; index++) {
      writeListEntry(`agent:main:cold-${index}`, {
        sessionId: `cold-${index}`,
        updatedAt: index + 1,
        createdActor: profileActor(alice.authenticatedUserProfile!.profileId),
        visibility: index === rows - 1 ? "draft" : "shared",
      });
    }
    using _ = retainList(context);
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    await projection.withSelectionPreparation(async () => {
      await projection.prepareSelection();
      const read = (client: typeof alice, limit = 100) =>
        readList(context, client, { limit, rowMode: "compact" });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_value, index) =>
          read({ ...alice, connId: `reconnect-${index}` }),
        ),
      );
      expect(results[0]!.sessions).toHaveLength(100);
      expect(results[0]!.totalCount).toBe(rows);
      expect(results[0]!.sessions[0]!.sessionId).toBe("cold-129");
      for (const result of results) {
        expect(result.sessions).toEqual(results[0]!.sessions);
        expect(result.owners).toBe(results[0]!.owners);
      }
      const other = await read(bob);
      expect(other.totalCount).toBe(rows - 1);
      expect(other.sessions[0]!.sessionId).toBe("cold-128");
      expect(other.owners).not.toBe(results[0]!.owners);
      expect((await read(alice, 1)).sessions).toHaveLength(1);
    });
  }));

it("shares encoded socket lists by identity and refreshes compact, published, and clock facts", async () => {
  const start = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  await withListReader("first-list", async ({ cfg, context, client }) => {
    const clients = [client, { ...client }, roleClient("view", "second-identity")];
    for (const recipient of clients) {
      prepareGatewayRecipientProfile(recipient);
    }
    const scope = { agentId: "main", sessionKey: "agent:main:serialized" };
    const entry = {
      sessionId: "serialized",
      updatedAt: start,
      label: "Original label",
      visibility: "shared" as const,
      agentStatus: { note: "Working", expiresAt: start + 100 },
      toolOverrides: { webSearch: false },
    };
    replaceSessionEntrySync(scope, entry);
    const read = (index: number, compact = true) =>
      readList(context, clients[index]!, compact ? { rowMode: "compact" } : {});
    const expectAt = async (elapsed: number, fields: object, index = 0, soft = false) => {
      clock.mockReturnValue(start + elapsed);
      (soft ? expect.soft : expect)((await read(index)).sessions[0]).toMatchObject({
        ...fields,
        snapshotAt: start + elapsed,
      });
    };
    // Admission work is not part of response encoding.
    await read(0, false);
    const stringify = vi.spyOn(JSON, "stringify");
    const first = await read(0, false);
    const firstWire = wire(first);
    clock.mockReturnValue(start + 1);
    const second = await read(1, false);
    const secondWire = wire(second);
    const rowTraversals = stringify.mock.calls.reduce((count, [value]) => {
      if (value && typeof value === "object" && "key" in value && value.key === scope.sessionKey) {
        return count + 1;
      }
      // A generic response stringify traverses every row again at the socket boundary.
      if (value && typeof value === "object" && "payload" in value) {
        const payload = value.payload as { sessions?: unknown[] };
        return count + (payload.sessions?.length ?? 0);
      }
      return count;
    }, 0);
    stringify.mockRestore();
    expect(rowTraversals).toBe(0);
    expect(JSON.parse(firstWire).payload.sessions).toEqual(JSON.parse(secondWire).payload.sessions);
    expect(first.sessions).toBe(second.sessions);
    expect(first.owners).toBe(second.owners);
    const projection = getSessionRowProjection(context)!;
    const present = vi.spyOn(projection, "present");
    const filter = vi.spyOn(listFilters, "filterSessionEntries");
    const clone = vi.spyOn(globalThis, "structuredClone");
    const unrelated = createSubagentRunRecord({
      runId: "unrelated-presentation",
      childSessionKey: "agent:main:subagent:unrelated-presentation",
      requesterSessionKey: "agent:main:unrelated-parent",
      createdAt: start,
    });
    try {
      for (const publish of [false, true]) {
        if (publish) {
          subagentRuns.set(unrelated.runId, unrelated);
          subagentRuns.commitOwnership(unrelated);
          publishSubagentRunChanges();
        }
        const unchanged = await read(0, false);
        expect(unchanged.sessions[0]).toBe(first.sessions[0]);
        expect(unchanged.owners).toBe(first.owners);
        expect(filter).not.toHaveBeenCalled();
        expect(present).not.toHaveBeenCalled();
        expect(
          clone.mock.calls.filter(
            ([value]) =>
              value !== null &&
              typeof value === "object" &&
              "key" in value &&
              value.key === scope.sessionKey,
          ),
        ).toHaveLength(0);
      }
    } finally {
      present.mockRestore();
      filter.mockRestore();
      clone.mockRestore();
      subagentRuns.delete(unrelated.runId);
    }
    const otherIdentity = await read(2, false);
    expect(otherIdentity.sessions).not.toBe(first.sessions);
    expect(otherIdentity.owners).not.toBe(first.owners);
    expect(first.sessions[0]).toMatchObject({ snapshotAt: start, agentStatus: entry.agentStatus });
    const compact = await read(0);
    expect(compact.sessions[0]).toMatchObject({ rowMode: "compact", label: "Original label" });
    expectAbsent(compact.sessions[0], SESSION_ROW_DETAIL_FIELDS);
    expect((await read(0, false)).sessions[0]).toHaveProperty("toolOverrides", entry.toolOverrides);
    clock.mockReturnValue(start + 101);
    expect((await read(0)).sessions[0]?.agentStatus).toBeUndefined();
    replaceSessionEntrySync(scope, { ...entry, label: "Published label" });
    const changed = await read(1);
    expect(JSON.parse(wire(changed)).payload.sessions[0]).toMatchObject({
      label: "Published label",
      permissionModePending: false,
      hasActiveRun: false,
      snapshotAt: start + 101,
    });
    const finishPermissionChange = beginSessionPermissionChange(entry.sessionId);
    try {
      await expectAt(102, { permissionModePending: true });
    } finally {
      finishPermissionChange();
    }
    await expectAt(103, { permissionModePending: false }, 1, true);
    clock.mockReturnValue(start + 104);
    const readActive = () => readList(context, clients[0]!, { activeOnly: true });
    expect((await readActive()).sessions).toHaveLength(0);
    const run = registerRpcSourceForTest({
      storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      runId: "serialization-run",
      sessionId: entry.sessionId,
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    });
    if (!run.entry) {
      throw new Error("Expected a registered serialization run");
    }
    const releaseRun = await claimRpcSourceForTest(run.entry);
    try {
      expect((await readActive()).sessions).toHaveLength(1);
      await expectAt(104, { hasActiveRun: true, activeRunIds: ["serialization-run"] });
    } finally {
      releaseRun();
      run.cleanup();
    }
    clock.mockReturnValue(start + 105);
    expect((await readActive()).sessions).toHaveLength(0);
    await expectAt(105, { hasActiveRun: false, activeRunIds: [] }, 1, true);
    replaceSessionEntrySync(scope, {
      ...entry,
      totalTokens: 20,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      goal: {
        schemaVersion: 1,
        id: "budget",
        objective: "Finish the task",
        status: "active",
        createdAt: start,
        updatedAt: start,
        tokenStart: 0,
        tokensUsed: 0,
        tokenBudget: 10,
        continuationTurns: 0,
      },
    });
    for (const [index, elapsed] of [105, 106].entries()) {
      clock.mockReturnValue(start + elapsed);
      expect((await read(index)).sessions[0]?.goal).toMatchObject({
        status: "budget_limited",
        budgetLimitedAt: start + elapsed,
      });
    }
    const childKey = "agent:main:subagent:serialization-runtime";
    replaceSessionEntrySync(
      { agentId: scope.agentId, sessionKey: childKey },
      { sessionId: "serialization-runtime", updatedAt: start, spawnedBy: scope.sessionKey },
    );
    const subagent = createSubagentRunRecord({
      runId: "serialization-runtime",
      childSessionKey: childKey,
      requesterSessionKey: scope.sessionKey,
      requesterAgentId: scope.agentId,
      createdAt: start,
      startedAt: start,
    });
    subagentRuns.set(subagent.runId, subagent);
    subagentRuns.commitOwnership(subagent);
    const claim = claimAgentRunContext(
      subagent.runId,
      { agentId: scope.agentId, sessionKey: childKey, sessionId: "serialization-runtime" },
      { trackOwner: true, ownsContext: true },
    );
    const releaseForeground = retainSessionListForegroundWork();
    try {
      // Creation also dirties the parent; only the clock may change between measured reads.
      await projection.ensureMaterialized();
      const readChildren = () =>
        readList(context, clients[0]!, { rowMode: "compact", spawnedBy: scope.sessionKey });
      clock.mockReturnValue(start + 1_000);
      await readChildren();
      const revision = projection.sharingRevision;
      const rowContext = projection.state.rowContext;
      for (const elapsed of [1_000, 2_000]) {
        clock.mockReturnValue(start + elapsed);
        const children = await readChildren();
        expect(projection.sharingRevision).toBe(revision);
        expect(projection.state.rowContext).toBe(rowContext);
        expect(children.sessions).toHaveLength(1);
        expect(children.sessions[0]).toMatchObject({
          key: childKey,
          status: "running",
          runtimeMs: elapsed,
          snapshotAt: start + elapsed,
        });
      }
    } finally {
      releaseForeground();
      releaseAgentRunContext(subagent.runId, claim);
      subagentRuns.delete(subagent.runId);
    }
  });
});

it("refreshes shared socket selection when the same viewer changes roles", () =>
  withListReader("selection-viewer", async ({ context, client }) => {
    const profileId = client.authenticatedUserProfile!.profileId;
    for (const [suffix, creator] of [
      ["owned", profileId],
      ["foreign", "other-profile"],
    ] as const) {
      writeListEntry(`agent:main:selection-${suffix}`, {
        sessionId: `selection-${suffix}`,
        updatedAt: 1,
        createdActor: profileActor(creator),
      });
    }
    const read = () => readList(context, client, { rowMode: "compact" });
    expect((await read()).totalCount).toBe(2);
    setUserProfileRole(profileId, "none");
    expect((await read()).sessions.map((row) => row.key)).toEqual(["agent:main:selection-owned"]);
    setUserProfileRole(profileId, "view");
    expect((await read()).totalCount).toBe(2);
  }));

it("retains each embedded reader's identity when their shared row presentation is identical", () =>
  withListReader("reader-a", async ({ context, client: firstClient }) => {
    const clients = [firstClient, roleClient("view", "reader-b")];
    for (const recipient of clients) {
      prepareGatewayRecipientProfile(recipient);
    }
    const scope = { agentId: "main", sessionKey: "agent:main:private-list" };
    replaceSessionEntrySync(scope, {
      sessionId: "private-list",
      updatedAt: Date.now(),
      visibility: "shared",
    });
    const rows = [];
    for (const client of clients) {
      const result = await readList(context, client, { rowMode: "compact" }, false);
      expect(result.sessions).toHaveLength(1);
      rows.push(result.sessions[0]!);
    }
    setUserProfileRole(clients[1]!.authenticatedUserProfile!.profileId, "none");
    expect(await withCurrentSessionListRows(rows, (visible) => visible, true)).toEqual([
      true,
      false,
    ]);
  }));

it("omits swarm detail reads from sidebar and dashboard pages while authorizing compact members", () =>
  withListReader("swarm-list-reader", async ({ context, client }) => {
    const creator = ensureProfileForEmail("swarm-list-owner@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    const parent = "agent:main:dashboard:swarm-parent";
    const children = ["agent:main:subagent:visible", "agent:main:subagent:hidden"];
    writeListEntry(parent, {
      sessionId: "swarm-parent",
      updatedAt: Date.now(),
      visibility: "shared",
    });
    for (const [index, child] of children.entries()) {
      writeListEntry(child, {
        sessionId: `swarm-child-${index}`,
        updatedAt: Date.now(),
        visibility: index === 0 ? "shared" : "draft",
        createdActor: profileActor(creator.id),
      });
      const runId = `swarm-list-${index}`;
      subagentRuns.set(
        runId,
        createSubagentRunRecord({
          runId,
          childSessionKey: child,
          requesterSessionKey: parent,
          requesterAgentId: "main",
          swarmRequesterSessionKey: parent,
          collect: true,
          groupId: "list-group",
          execution: { status: "terminal", startedAt: 1, endedAt: 2 },
          collectorCompletion: { status: "done" },
        }),
      );
    }
    const foreground = retainList(context);
    const read = (rowMode: "sidebar" | "dashboard" | "compact") =>
      readList(context, client, { rowMode, excludeSubagents: true });
    try {
      await initializeSessionReadContext(context);
      const projection = getSessionRowProjection(context)!;
      await projection.ensureMaterialized();
      for (const rowMode of ["sidebar", "dashboard"] as const) {
        await read(rowMode);
        const selections = vi.spyOn(projection, "selectEntries");
        try {
          const page = await read(rowMode);
          expect(page.sessions).toHaveLength(1);
          expect(expandSessionRowFacts(page.sessions, page.sharedFacts)[0]).not.toHaveProperty(
            "swarm",
          );
          // A warmed page must not read children solely for omitted swarm detail.
          expect(selections).not.toHaveBeenCalled();
        } finally {
          selections.mockRestore();
        }
      }
      const sidebar = await read("sidebar");
      const compact = await read("compact");
      expect(compact.sessions[0]?.swarm?.groups).toMatchObject([
        { groupId: "list-group", done: 2, children: [{ sessionKey: children[0], status: "done" }] },
      ]);
      expect(compact.sessions[0]?.swarm?.groups[0]?.children).toHaveLength(1);
      expect((await read("sidebar")).sessions).toBe(sidebar.sessions);
    } finally {
      foreground[Symbol.dispose]();
      for (let index = 0; index < children.length; index++) {
        subagentRuns.delete(`swarm-list-${index}`);
      }
    }
  }));
