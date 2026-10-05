import { afterEach, expect, it, vi } from "vitest";
import { SESSION_ROW_DETAIL_FIELDS } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { listSessions, requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { withCurrentSessionListRows } from "./session-list-read-result.js";
import { beginSessionPermissionChange } from "./session-permission-change.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("shares encoded socket lists by identity and refreshes compact, published, and clock facts", async () => {
  const start = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const context = requestContext(cfg);
    const client = roleClient("view", "first-list");
    const clients = [client, { ...client }, roleClient("view", "second-identity")];
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
      listSessions({
        client: clients[index]!,
        context,
        request: compact ? { rowMode: "compact" } : {},
        acceptsSerializedJson: true,
      });
    // Admission work is not part of response encoding.
    await read(0, false);
    const stringify = vi.spyOn(JSON, "stringify");
    const first = await read(0, false);
    const frame = (payload: unknown) => ({ type: "res", id: "list", ok: true, payload });
    const firstWire = serializeGatewayFrame(frame(first)).toString();
    clock.mockReturnValue(start + 1);
    const second = await read(1, false);
    const secondWire = serializeGatewayFrame(frame(second)).toString();
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
    const otherIdentity = await read(2, false);
    expect(otherIdentity.sessions).not.toBe(first.sessions);
    expect(otherIdentity.owners).not.toBe(first.owners);
    expect(first.sessions[0]).toMatchObject({ snapshotAt: start, agentStatus: entry.agentStatus });
    const compact = await read(0);
    expect(compact.sessions[0]).toMatchObject({ rowMode: "compact", label: "Original label" });
    for (const field of SESSION_ROW_DETAIL_FIELDS) {
      expect(compact.sessions[0]).not.toHaveProperty(field);
    }
    expect((await read(0, false)).sessions[0]).toHaveProperty("toolOverrides", entry.toolOverrides);
    clock.mockReturnValue(start + 101);
    expect((await read(0)).sessions[0]?.agentStatus).toBeUndefined();
    replaceSessionEntrySync(scope, { ...entry, label: "Published label" });
    const changed = await read(1);
    expect(
      JSON.parse(serializeGatewayFrame(frame(changed)).toString()).payload.sessions[0],
    ).toMatchObject({
      label: "Published label",
      permissionModePending: false,
      hasActiveRun: false,
      snapshotAt: start + 101,
    });
    const finishPermissionChange = beginSessionPermissionChange(entry.sessionId);
    try {
      clock.mockReturnValue(start + 102);
      expect((await read(0)).sessions[0]).toMatchObject({
        permissionModePending: true,
        snapshotAt: start + 102,
      });
    } finally {
      finishPermissionChange();
    }
    clock.mockReturnValue(start + 103);
    expect.soft((await read(1)).sessions[0]).toMatchObject({
      permissionModePending: false,
      snapshotAt: start + 103,
    });
    clock.mockReturnValue(start + 104);
    const readActive = () =>
      listSessions({
        client: clients[0]!,
        context,
        request: { activeOnly: true },
        acceptsSerializedJson: true,
      });
    expect((await readActive()).sessions).toHaveLength(0);
    const run = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "serialization-run",
      sessionId: entry.sessionId,
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      timeoutMs: 60_000,
    });
    try {
      expect((await readActive()).sessions).toHaveLength(1);
      expect((await read(0)).sessions[0]).toMatchObject({
        hasActiveRun: true,
        activeRunIds: ["serialization-run"],
        snapshotAt: start + 104,
      });
    } finally {
      run.cleanup();
    }
    clock.mockReturnValue(start + 105);
    expect((await readActive()).sessions).toHaveLength(0);
    expect.soft((await read(1)).sessions[0]).toMatchObject({
      hasActiveRun: false,
      activeRunIds: [],
      snapshotAt: start + 105,
    });
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
    expect((await read(0)).sessions[0]?.goal).toMatchObject({
      status: "budget_limited",
      budgetLimitedAt: start + 105,
    });
    clock.mockReturnValue(start + 106);
    expect((await read(1)).sessions[0]?.goal).toMatchObject({
      status: "budget_limited",
      budgetLimitedAt: start + 106,
    });
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
      const projection = getSessionRowProjection(context)!;
      // Creation also dirties the parent; only the clock may change between measured reads.
      await projection.ensureMaterialized();
      const readChildren = () =>
        listSessions({
          client: clients[0]!,
          context,
          request: { rowMode: "compact", spawnedBy: scope.sessionKey },
          acceptsSerializedJson: true,
        });
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

it("refreshes shared socket selection when the same viewer changes roles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const context = requestContext(cfg);
    const client = roleClient("view", "selection-viewer");
    const profileId = client.authenticatedUserProfile!.profileId;
    for (const [suffix, creator] of [
      ["owned", profileId],
      ["foreign", "other-profile"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:selection-${suffix}` },
        {
          sessionId: `selection-${suffix}`,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: creator },
        },
      );
    }
    const read = () =>
      listSessions({
        client,
        context,
        request: { rowMode: "compact" },
        acceptsSerializedJson: true,
      });
    expect((await read()).totalCount).toBe(2);
    setUserProfileRole(profileId, "none");
    expect((await read()).sessions.map((row) => row.key)).toEqual(["agent:main:selection-owned"]);
    setUserProfileRole(profileId, "view");
    expect((await read()).totalCount).toBe(2);
  });
});

it("retains each embedded reader's identity when their shared row presentation is identical", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const context = requestContext(cfg);
    const clients = [roleClient("view", "reader-a"), roleClient("view", "reader-b")];
    const scope = { agentId: "main", sessionKey: "agent:main:private-list" };
    replaceSessionEntrySync(scope, {
      sessionId: "private-list",
      updatedAt: Date.now(),
      visibility: "shared",
    });
    const rows = [];
    for (const client of clients) {
      const result = await listSessions({
        client,
        context,
        request: { rowMode: "compact" },
        acceptsSerializedJson: false,
      });
      expect(result.sessions).toHaveLength(1);
      rows.push(result.sessions[0]!);
    }
    setUserProfileRole(clients[1]!.authenticatedUserProfile!.profileId, "none");
    expect(await withCurrentSessionListRows(rows, (visible) => visible, true)).toEqual([
      true,
      false,
    ]);
  });
});
