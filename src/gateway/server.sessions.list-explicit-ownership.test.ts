import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

setupGatewaySessionsHandlerTestHarness();

test("sessions.list preserves recorded sentinel owners for explicit multi-agent federation", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "explicit-ownership-list-regression");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const agentsDir = path.join(stateDir, "agents");
    const storeTemplate = path.join(agentsDir, "{agentId}", "sessions", "sessions.json");
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = {
      ownership: "explicit",
      list: [{ id: "ops" }, { id: "research" }],
    };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    const linkedSessionKey = "subagent:workboard-default-owned";
    await writeSessionStore({
      storePath: storeTemplate.replace("{agentId}", "ops"),
      agentId: "ops",
      entries: {
        main: { sessionId: "sess-ops", updatedAt: 20 },
        global: { sessionId: "sess-global", updatedAt: 19 },
        unknown: { sessionId: "sess-unknown", updatedAt: 18 },
      },
    });
    await writeSessionStore({
      storePath: storeTemplate.replace("{agentId}", "research"),
      agentId: "research",
      entries: {
        main: { sessionId: "sess-research", updatedAt: 21 },
        [linkedSessionKey]: { sessionId: "sess-linked", updatedAt: 22 },
      },
    });

    const all = await directSessionReq<{
      sessions: Array<{ key: string; agentId: string; sessionId: string }>;
      count: number;
      totalCount: number;
      hasMore: boolean;
    }>("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
    });
    expect(all.ok).toBe(true);
    expect(all.payload).toMatchObject({ count: 5, totalCount: 5, hasMore: false });
    expect(
      all.payload?.sessions.map(({ key, agentId, sessionId }) => ({ key, agentId, sessionId })),
    ).toEqual([
      { key: `agent:research:${linkedSessionKey}`, agentId: "research", sessionId: "sess-linked" },
      { key: "agent:research:main", agentId: "research", sessionId: "sess-research" },
      { key: "agent:ops:main", agentId: "ops", sessionId: "sess-ops" },
      { key: "global", agentId: "ops", sessionId: "sess-global" },
      { key: "unknown", agentId: "ops", sessionId: "sess-unknown" },
    ]);

    const linkedQuery = {
      search: linkedSessionKey,
      archived: "all",
      limit: 2,
      configuredAgentsOnly: false,
      includeDerivedTitles: false,
      includeLastMessage: false,
    };
    for (const [includeGlobal, includeUnknown] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ]) {
      const linked = await directSessionReq("sessions.list", {
        ...linkedQuery,
        includeGlobal,
        includeUnknown,
      });
      expect(linked).toMatchObject({
        ok: true,
        payload: {
          sessions: [
            {
              key: `agent:research:${linkedSessionKey}`,
              agentId: "research",
              sessionId: "sess-linked",
            },
          ],
          count: 1,
          hasMore: false,
          totalCount: 1,
        },
      });
    }

    const configuredOnly = await directSessionReq<{ sessions: Array<{ key: string }> }>(
      "sessions.list",
      { includeGlobal: false, includeUnknown: false, configuredAgentsOnly: true },
    );
    expect(configuredOnly.ok).toBe(true);
    expect(configuredOnly.payload?.sessions.map((session) => session.key)).toEqual([
      `agent:research:${linkedSessionKey}`,
      "agent:research:main",
      "agent:ops:main",
    ]);
  });
});

test("sessions.list preserves separate registered targets under a fixed store owner", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "fixed-owner-registered-list");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const storePath = path.join(stateDir, "shared.json");
    for (const agentId of ["main", "ops"]) {
      replaceSessionEntrySync(
        { agentId, defaultAgentId: "main", sessionKey: "global", storePath },
        { sessionId: `global-${agentId}`, updatedAt: 1 },
      );
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "unknown", storePath: path.join(stateDir, "separate.sqlite") },
      { sessionId: "separate-main", updatedAt: 2 },
    );
    testState.sessionConfig = { store: storePath };
    testState.agentsConfig = { ownership: "explicit", list: [{ id: "main" }, { id: "ops" }] };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    const client: GatewayClient = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.admin"],
      },
    };
    const scoped = await directSessionReq(
      "sessions.get",
      { key: "unknown", agentId: "main" },
      { client },
    );
    expect(scoped).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("does not match") },
    });
    const listed = await directSessionReq<{
      sessions: Array<{ key: string; agentId: string; sessionId: string }>;
    }>(
      "sessions.list",
      { configuredAgentsOnly: true, includeGlobal: true, includeUnknown: true },
      { client },
    );
    expect(listed.ok).toBe(true);
    expect(
      listed.payload?.sessions.map(({ key, agentId, sessionId }) => ({ key, agentId, sessionId })),
    ).toEqual([
      { key: "unknown", agentId: "main", sessionId: "separate-main" },
      { key: "global", agentId: "main", sessionId: "global-main" },
    ]);
  });
});

test.for(
  (["delete", "draft", "join", "leave"] as const).flatMap((change) => [
    { change, alias: false },
    { change, alias: true },
  ]),
)(
  "sessions.list refreshes $change against the selected physical database (alias=$alias)",
  async ({ change, alias }, context) => {
    if (alias && process.platform === "win32") {
      context.skip();
    }
    const rootStateDir = process.env.OPENCLAW_STATE_DIR;
    if (!rootStateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
    }
    const stateDir = path.join(rootStateDir, `physical-sharing-${change}-${alias}`);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const storePath = path.join(stateDir, "shared.sqlite");
      const physicalPath = alias
        ? path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")
        : storePath;
      testState.sessionConfig = { store: storePath };
      testState.agentsConfig = { ownership: "explicit", list: [{ id: "main" }, { id: "ops" }] };
      testState.agentConfig = { sessionStore: { agentId: "ops" } };
      openOpenClawAgentDatabase({ agentId: "main", path: physicalPath });
      if (alias) {
        await fs.symlink(physicalPath, storePath);
      }
      const key = "agent:ops:physical-sharing";
      const scope = { agentId: "ops", storePath, sessionKey: key };
      const entry = {
        sessionId: "ops-physical-session",
        updatedAt: 10,
        displayName: "Physical database title",
        visibility:
          change === "join" || change === "leave" ? ("read-only" as const) : ("shared" as const),
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      await writeSessionStore({ agentId: scope.agentId, storePath, entries: { [key]: entry } });
      await seedSessionTranscript({
        ...scope,
        sessionId: entry.sessionId,
        messages: [{ role: "user", content: "Physical database preview" }],
      });
      if (change === "leave") {
        addSessionMember(scope, {
          identityId: "viewer",
          addedBy: "owner",
          expectedSessionId: entry.sessionId,
        });
      }
      const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
      const projection = await createSessionRowProjection({ cfg });
      await vi.waitFor(() =>
        expect(
          projection.snapshot(
            { key, agentId: "ops" },
            { includeDerivedTitles: true, includeLastMessage: true },
          ).row,
        ).toMatchObject({
          derivedTitle: "Physical database title",
          lastMessagePreview: "Physical database preview",
        }),
      );
      const ensure = projection.ensureMaterialized;
      const spy = vi.spyOn(projection, "ensureMaterialized").mockImplementationOnce(async () => {
        await ensure();
        expect(
          projection.snapshot(
            { key, agentId: "ops" },
            { includeDerivedTitles: true, includeLastMessage: true },
          ).row,
        ).toMatchObject({
          key,
          agentId: "ops",
          derivedTitle: "Physical database title",
          lastMessagePreview: "Physical database preview",
        });
        if (change === "delete") {
          await deleteSessionEntryLifecycle({
            agentId: scope.agentId,
            storePath,
            target: { canonicalKey: key, storeKeys: [key] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
        } else if (change === "draft") {
          replaceSessionEntrySync(scope, { ...entry, visibility: "draft" });
        } else if (change === "join") {
          addSessionMember(scope, {
            identityId: "viewer",
            addedBy: "owner",
            expectedSessionId: entry.sessionId,
          });
        } else {
          removeSessionMember(scope, "viewer", undefined, entry.sessionId);
        }
        await ensure();
      });
      try {
        const result = await directSessionReq<SessionsListResult>(
          "sessions.list",
          { configuredAgentsOnly: true, includeDerivedTitles: true, includeLastMessage: true },
          {
            client: sharingPolicyClient({ user: "viewer" }),
            context: bindSessionRowProjection({}, () => projection),
          },
        );
        expect(result.ok).toBe(true);
        expect(spy).toHaveBeenCalled();
        if (change === "delete" || change === "draft") {
          expect(result.payload?.sessions).toEqual([]);
        } else {
          expect(result.payload?.sessions).toMatchObject([
            {
              key,
              agentId: "ops",
              sessionId: entry.sessionId,
              derivedTitle: "Physical database title",
              visibility: "read-only",
              sharingRole: change === "join" ? "member" : "viewer",
            },
          ]);
        }
      } finally {
        spy.mockRestore();
        projection.dispose();
      }
    });
  },
);

test("captured sentinel rows never substitute a later same-owner session after deletion", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "same-owner-sentinel");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const first = {
      agentId: "main",
      storePath: path.join(stateDir, "a-first.sqlite"),
      sessionKey: "unknown",
    };
    const second = { ...first, storePath: path.join(stateDir, "z-second.sqlite") };
    replaceSessionEntrySync(first, { sessionId: "first-sentinel", updatedAt: 1 });
    replaceSessionEntrySync(second, { sessionId: "later-sentinel", updatedAt: 2 });
    testState.agentsConfig = { list: [{ id: "main", default: true }] };
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    const projection = await createSessionRowProjection({ cfg });
    const client = sharingPolicyClient({ user: "viewer" });
    const options = { client, context: bindSessionRowProjection({}, () => projection) };
    try {
      const selected = await directSessionReq<SessionsListResult>(
        "sessions.list",
        { configuredAgentsOnly: true, includeUnknown: true },
        options,
      );
      expect(selected.ok).toBe(true);
      expect(selected.payload?.sessions).toMatchObject([
        { key: "unknown", agentId: "main", sessionId: "first-sentinel" },
      ]);
      const captured = projection.describe({
        key: "unknown",
        agentId: "main",
        storePath: first.storePath,
      })!;
      await deleteSessionEntryLifecycle({
        ...first,
        target: { canonicalKey: "unknown", storeKeys: ["unknown"] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });
      await projection.ensureMaterialized();
      expect(prepareProjectedSessionPresentation(projection, client).present(captured)).toBeNull();
      const connection = createGatewayConnectionState({ bootId: "retired-sentinel", cfg });
      const send = vi.fn();
      const recipient = {
        ...client,
        connId: "sentinel-reader",
        connect: { ...client.connect, scopes: ["operator.admin"] },
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send,
          close: vi.fn(),
        } as unknown as GatewayWsClient["socket"],
      } as GatewayWsClient;
      connection.clients.add(recipient);
      const detach = connection.attachSessionRowProjection(projection);
      try {
        connection.broadcast("sessions.changed", {
          sessionKey: "unknown",
          agentId: "main",
          session: selected.payload!.sessions[0],
        });
        expect(send).not.toHaveBeenCalled();
      } finally {
        detach();
        connection.mentionInbox.dispose();
      }
      // A new selection may use the remaining physical row; the captured identity may not.
      const current = await directSessionReq<SessionsListResult>(
        "sessions.list",
        { configuredAgentsOnly: true, includeUnknown: true },
        options,
      );
      expect(current.payload?.sessions).toMatchObject([
        { key: "unknown", agentId: "main", sessionId: "later-sentinel" },
      ]);
    } finally {
      projection.dispose();
    }
  });
});
