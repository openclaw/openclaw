import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createTestNodeSocket } from "./node-registry.test-helpers.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as projectionRecords from "./session-row-projection-record.js";
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

async function withSessionState(name: string, run: (stateDir: string) => Promise<void>) {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, name);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () => run(stateDir));
}

function configureExplicitOwner(
  store: string,
  entries: NonNullable<typeof testState.agentsConfig>["entries"],
) {
  testState.sessionConfig = { store };
  testState.agentsConfig = { ownership: "explicit", entries };
  testState.agentConfig = { sessionStore: { agentId: "ops" } };
}

const previewOptions = { includeDerivedTitles: true, includeLastMessage: true };
const preview = {
  derivedTitle: "Physical database title",
  lastMessagePreview: "Physical database preview",
};
const identities = (sessions: SessionsListResult["sessions"] | undefined) =>
  sessions?.map(({ key, agentId, sessionId }) => ({ key, agentId, sessionId }));
async function list(
  params: Record<string, unknown>,
  options?: Parameters<typeof directSessionReq<SessionsListResult>>[2],
) {
  const result = await directSessionReq<SessionsListResult>("sessions.list", params, options);
  expect(result.ok).toBe(true);
  return result.payload!;
}
function remove(scope: { agentId: string; storePath: string; sessionKey: string }) {
  return deleteSessionEntryLifecycle({
    ...scope,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
  });
}

test("sessions.list preserves recorded sentinel owners for explicit multi-agent federation", async () => {
  await withSessionState("explicit-ownership-list-regression", async (stateDir) => {
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    configureExplicitOwner(storeTemplate, { ops: {}, research: {} });
    const linkedSessionKey = "subagent:workboard-default-owned";
    const linkedIdentity = {
      key: `agent:research:${linkedSessionKey}`,
      agentId: "research",
      sessionId: "sess-linked",
    };
    await writeSessionStore({
      storePath: storeTemplate.replace("{agentId}", "ops"),
      agentId: "ops",
      entries: {
        main: { sessionId: "sess-ops", updatedAt: 20 },
        global: { sessionId: "sess-global", updatedAt: 19 },
        unknown: { sessionId: "sess-unknown", updatedAt: 18, label: "Unknown sentinel" },
        "agent:ops:unknown": { sessionId: "sess-named-unknown", updatedAt: 23 },
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

    const all = await list({
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
    });
    expect(all).toMatchObject({ count: 6, totalCount: 6, hasMore: false });
    expect(identities(all.sessions)).toEqual([
      { key: "agent:ops:unknown", agentId: "ops", sessionId: "sess-named-unknown" },
      linkedIdentity,
      { key: "agent:research:main", agentId: "research", sessionId: "sess-research" },
      { key: "agent:ops:main", agentId: "ops", sessionId: "sess-ops" },
      { key: "global", agentId: "ops", sessionId: "sess-global" },
      { key: "unknown", agentId: "ops", sessionId: "sess-unknown" },
    ]);

    for (const includeUnknown of [false, true]) {
      const scoped = await list({
        agentId: "ops",
        includeGlobal: true,
        includeUnknown,
        configuredAgentsOnly: true,
      });
      expect(identities(scoped.sessions)).toEqual([
        { key: "agent:ops:unknown", agentId: "ops", sessionId: "sess-named-unknown" },
        { key: "agent:ops:main", agentId: "ops", sessionId: "sess-ops" },
        { key: "global", agentId: "ops", sessionId: "sess-global" },
        ...(includeUnknown ? [{ key: "unknown", agentId: "ops", sessionId: "sess-unknown" }] : []),
      ]);
      expect(scoped).toMatchObject({
        count: includeUnknown ? 4 : 3,
        totalCount: includeUnknown ? 4 : 3,
        hasMore: false,
      });
      for (const selector of [{ sessionId: "sess-unknown" }, { label: "Unknown sentinel" }]) {
        const resolved = await directSessionReq("sessions.resolve", {
          ...selector,
          agentId: "ops",
          includeUnknown,
          allowMissing: true,
        });
        expect(resolved).toMatchObject({
          ok: true,
          payload: includeUnknown ? { ok: true, key: "unknown", agentId: "ops" } : { ok: false },
        });
      }
    }

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
      const linked = await list({
        ...linkedQuery,
        includeGlobal,
        includeUnknown,
      });
      expect(linked).toMatchObject({
        sessions: [linkedIdentity],
        count: 1,
        hasMore: false,
        totalCount: 1,
      });
    }

    const configuredOnly = await list({
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    expect(configuredOnly.sessions.map((session) => session.key)).toEqual([
      "agent:ops:unknown",
      `agent:research:${linkedSessionKey}`,
      "agent:research:main",
      "agent:ops:main",
    ]);
  });
});

test("sessions.list preserves separate registered targets under a fixed store owner", async () => {
  await withSessionState("fixed-owner-registered-list", async (stateDir) => {
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
    configureExplicitOwner(storePath, { main: {}, ops: {} });
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    const scoped = await directSessionReq(
      "sessions.get",
      { key: "unknown", agentId: "main" },
      { client },
    );
    expect(scoped).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("does not match") },
    });
    const listed = await list(
      { configuredAgentsOnly: true, includeGlobal: true, includeUnknown: true },
      { client },
    );
    expect(identities(listed.sessions)).toEqual([
      { key: "unknown", agentId: "main", sessionId: "separate-main" },
      { key: "global", agentId: "main", sessionId: "global-main" },
    ]);
  });
});

test.for(["delete", "draft", "join", "leave"] as const)(
  "sessions.list refreshes %s against the selected physical database",
  async (change) => {
    const alias = process.platform !== "win32";
    await withSessionState(`physical-sharing-${change}-${alias}`, async (stateDir) => {
      const storePath = path.join(stateDir, "shared.sqlite");
      const physicalPath = alias
        ? path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")
        : storePath;
      configureExplicitOwner(storePath, { main: {}, ops: {} });
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
        messages: [{ role: "user", content: preview.lastMessagePreview }],
      });
      const join = () =>
        addSessionMember(scope, {
          identityId: "viewer",
          addedBy: "owner",
          expectedSessionId: entry.sessionId,
        });
      if (change === "leave") {
        join();
      }
      const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
      const previewPublished = createDeferred();
      const publishTranscriptFields = projectionRecords.publishTranscriptFields;
      using publication = vi
        .spyOn(projectionRecords, "publishTranscriptFields")
        .mockImplementation((...args) => {
          const published = publishTranscriptFields(...args);
          const [row] = args;
          if (
            row.key === key &&
            row.entry.sessionId === entry.sessionId &&
            row.lastMessagePreview === preview.lastMessagePreview
          ) {
            previewPublished.resolve();
          }
          return published;
        });
      const projection = await createSessionRowProjection({ cfg });
      const target = { key, agentId: "ops" };
      const snapshot = () => projection.snapshot(target, previewOptions).row;
      const prepare = projection.prepareSelection;
      const spy = vi
        .spyOn(projection, "prepareSelection")
        .mockImplementationOnce(async (...args) => {
          await prepare(...args);
          expect(snapshot()).toMatchObject({ ...target, ...preview });
          if (change === "delete") {
            await remove(scope);
          } else if (change === "draft") {
            replaceSessionEntrySync(scope, { ...entry, visibility: "draft" });
          } else if (change === "join") {
            join();
          } else {
            removeSessionMember(scope, "viewer", undefined, entry.sessionId);
          }
          return prepare(...args);
        });
      try {
        await projection.ensureMaterialized();
        projection.describe(target);
        await previewPublished.promise;
        publication.mockRestore();
        expect(snapshot()).toMatchObject(preview);
        const result = await list(
          { configuredAgentsOnly: true, ...previewOptions },
          {
            client: sharingPolicyClient({ user: "viewer" }),
            context: bindSessionRowProjection({}, () => projection),
          },
        );
        expect(spy).toHaveBeenCalled();
        if (change === "delete" || change === "draft") {
          expect(result.sessions).toEqual([]);
        } else {
          expect(result.sessions).toMatchObject([
            {
              ...target,
              sessionId: entry.sessionId,
              derivedTitle: preview.derivedTitle,
              visibility: "read-only",
              sharingRole: change === "join" ? "member" : "viewer",
            },
          ]);
        }
      } finally {
        spy.mockRestore();
        projection.dispose();
        await projection.ensureMaterialized();
      }
    });
  },
);

test("captured sentinel rows never substitute a later same-owner session after deletion", async () => {
  await withSessionState("same-owner-sentinel", async (stateDir) => {
    const first = {
      agentId: "main",
      storePath: path.join(stateDir, "a-first.sqlite"),
      sessionKey: "unknown",
    };
    const second = { ...first, storePath: path.join(stateDir, "z-second.sqlite") };
    replaceSessionEntrySync(first, { sessionId: "first-sentinel", updatedAt: 1 });
    replaceSessionEntrySync(second, { sessionId: "later-sentinel", updatedAt: 2 });
    testState.agentsConfig = { entries: { main: {} } };
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    const projection = await createSessionRowProjection({ cfg });
    const client = sharingPolicyClient({ user: "viewer" });
    const options = { client, context: bindSessionRowProjection({}, () => projection) };
    try {
      const params = { configuredAgentsOnly: true, includeUnknown: true };
      const selected = await list(params, options);
      expect(selected.sessions).toMatchObject([
        { key: "unknown", agentId: "main", sessionId: "first-sentinel" },
      ]);
      const captured = projection.describe({ key: first.sessionKey, ...first })!;
      await remove(first);
      await projection.ensureMaterialized();
      expect(prepareProjectedSessionPresentation(projection, client).present(captured)).toBeNull();
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "retired-sentinel",
        cfg,
      });
      const socket = createTestNodeSocket();
      const recipient = {
        ...client,
        connId: "sentinel-reader",
        connect: { ...client.connect, scopes: ["operator.admin"] },
        socket: socket as unknown as GatewayWsClient["socket"],
      } as GatewayWsClient;
      connection.clients.add(recipient);
      const detach = connection.attachSessionRowProjection(projection);
      try {
        connection.broadcast("sessions.changed", {
          sessionKey: "unknown",
          agentId: "main",
          session: selected.sessions[0],
        });
        expect(socket.send).not.toHaveBeenCalled();
      } finally {
        detach();
        await connection.mentionInbox.dispose();
      }
      const current = await list(params, options);
      expect(current.sessions).toMatchObject([
        { key: "unknown", agentId: "main", sessionId: "later-sentinel" },
      ]);
    } finally {
      projection.dispose();
    }
  });
});
