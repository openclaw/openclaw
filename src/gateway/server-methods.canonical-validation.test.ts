import { symlinkSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.sqlite-initial-entry.js";
import { markCanonicalSessionValidationPending } from "../config/sessions/session-canonical-key.js";
import * as readiness from "../config/sessions/session-canonical-validation-readiness.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { dispatchAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { authorizeGatewayRequestPreDispatch } from "./server-methods/request-authorization.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import * as rowFacts from "./session-row-database-facts.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const cleanKey = "agent:main:clean";
const dirtyKey = "agent:main:dirty-0";
const dirtyKeys = Array.from({ length: 1000 }, (_, i) => `agent:main:dirty-${i}`);
const reader = () => sharingPolicyClient({ user: "reader", scopes: ["operator.sessions.read"] });

function seed(sessionId: string, visibility?: "shared") {
  const sessionKey = `agent:main:${sessionId}`;
  ensureSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1, visibility });
  return sessionKey;
}

function setParent(database: ReturnType<typeof openOpenClawAgentDatabase>, parent: string | null) {
  database.db
    .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
    .run(parent, dirtyKey);
}

it("keeps prepared authorization bound through a configured database alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = seed("alias");
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const alias = state.statePath("session-alias.sqlite");
    symlinkSync(database.path, alias);
    const cfg = { session: { store: alias } };
    await state.writeConfig(cfg);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      const context = bindSessionRowProjection(
        { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        () => projection,
      );
      const result = await authorizeGatewayRequestPreDispatch({
        method: "sessions.messages.subscribe",
        requestParams: { key },
        client: sharingPolicyClient({ user: "member", scopes: ["operator.sessions.read"] }),
        context,
        methodRegistry: createRequestGatewayMethodRegistry(),
      });
      expect(result).toMatchObject({
        error: null,
        sessionMutationAuthorization: { admittedTarget: { sessionId: "alias" } },
      });
      expect(() => result.sessionMutationAuthorization?.assertCurrent()).not.toThrow();
    } finally {
      projection.dispose();
    }
  });
});

it.each(["sessions.patch", "talk.session.create"])(
  "authorizes %s without admitting an invalid unrelated row",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = seed("canonical-readiness", "shared");
      seed("unrelated-invalid");
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = entry_json || ' ' WHERE session_key = ?")
        .run(sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);
      database.db.exec(
        "UPDATE session_nodes SET parent_session_key = 'agent:main:mismatch' WHERE session_key = 'agent:main:unrelated-invalid'",
      );
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { allowed: true }),
      );
      const respond = await dispatchAuthorizationRequest(
        method,
        method === "sessions.patch" ? { key: sessionKey } : { sessionKey },
        {
          context: {
            getRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as unknown as GatewayRequestContext,
          client: sharingPolicyClient({ user: "member", scopes: ["operator.write"] }),
          extraHandlers: { [method]: handler },
        },
        "canonical-target",
      );
      expect(handler).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, { allowed: true });
    });
  },
);

it("authorizes exact rows independently of bulk validation and fences corrupt subscriptions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const insert = database.db.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, entry_valid, updated_at)
      VALUES (?, ?, ?, 1, 1)`);
    database.db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i <= 1000; i++) {
      const id = i === 1000 ? "clean" : `dirty-${i}`;
      insert.run(
        `agent:main:${id}`,
        id,
        JSON.stringify({ sessionId: id, updatedAt: 1, visibility: "shared" }),
      );
    }
    database.db.exec("UPDATE session_nodes SET entry_valid = 1; COMMIT");
    markCanonicalSessionValidationPending(database);
    await readiness.certifySessionCanonicalValidationPending({ agentId: "main" });
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    const work: Promise<unknown>[] = [];
    const bulkEntered = createDeferredCore();
    const rowEntered = createDeferredCore();
    const releaseRow = createDeferredCore();
    const joinedBulk = createDeferredCore<string>();
    let resumeBulk: (() => void) | undefined;
    try {
      await projection.ensureMaterialized();
      projection.describe({ agentId: "main", key: cleanKey });
      database.db.exec(`UPDATE session_nodes SET entry_json = entry_json || ' '
        WHERE session_key != 'agent:main:clean'; UPDATE session_nodes SET entry_valid = 1`);
      markCanonicalSessionValidationPending(database, dirtyKeys);
      // Reopening creates an unadmitted reader, as after startup or idle reader retirement.
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      sessionChanges.emitBatch(
        dirtyKeys.map((sessionKey) => ({
          sessionKey,
          agentId: "main",
          storePath: database.path,
          factsInvalidated: true as const,
        })),
      );
      const createWorker = archiveWorker.createSqliteTranscriptArchiveWorker;
      let holdNext = true;
      vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        const worker = createWorker(data);
        const post = worker.postMessage.bind(worker);
        vi.spyOn(worker, "postMessage").mockImplementation((message: unknown, ...args) => {
          if (holdNext && isRecord(message) && message.type === "canonical-validation") {
            holdNext = false;
            resumeBulk = () => post(message, ...args);
            bulkEntered.resolve();
            return;
          }
          post(message, ...args);
        });
        return worker;
      });
      work.push(readiness.certifySessionCanonicalValidationPending({ agentId: "main" }));
      await bulkEntered.promise;
      const certify = readiness.certifySessionCanonicalValidationPending;
      vi.spyOn(readiness, "certifySessionCanonicalValidationPending").mockImplementation(
        (...args) => {
          joinedBulk.resolve("joined bulk validation");
          return certify(...args);
        },
      );
      const readFacts = rowFacts.withSessionRowDatabaseFacts;
      vi.spyOn(rowFacts, "withSessionRowDatabaseFacts").mockImplementation(async (...args) => {
        rowEntered.resolve();
        await releaseRow.promise;
        return readFacts(...args);
      });
      const subscribeSessionMessageEvents = vi.fn();
      const context = bindSessionRowProjection(
        {
          getRuntimeConfig: () => ({}),
          subscribeSessionMessageEvents,
          logGateway: { warn: vi.fn(), error: vi.fn() },
        } as unknown as GatewayRequestContext,
        () => projection,
      );
      const client = reader();
      const methodRegistry = createRequestGatewayMethodRegistry();
      const authorize = (key?: string, requestClient = client, requestContext = context) => {
        const result = authorizeGatewayRequestPreDispatch({
          method: key ? "sessions.describe" : "sessions.list",
          requestParams: key ? { key } : {},
          client: requestClient,
          context: requestContext,
          methodRegistry,
        });
        work.push(result);
        return result;
      };
      const cleanReads = Promise.all([authorize(cleanKey), authorize()]);
      expect(await Promise.race([cleanReads, joinedBulk.promise])).toEqual([
        expect.objectContaining({ error: null }),
        expect.objectContaining({ error: null }),
      ]);
      const parse = vi.spyOn(JSON, "parse");
      const subscribe = (key: string, connId: string) =>
        dispatchAuthorizationRequest(
          "sessions.messages.subscribe",
          { key },
          {
            context,
            client: { ...client, connId },
            extraHandlers: sessionSubscriptionHandlers,
          },
          connId,
        );
      const respond = await subscribe(cleanKey, "clean-subscribe");
      expect(respond).toHaveBeenCalledWith(
        true,
        { subscribed: true, key: cleanKey, agentId: "main" },
        undefined,
      );
      expect(
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"dirty-')),
      ).toHaveLength(0);
      parse.mockRestore();
      let dirtySettled = false;
      const dirty = authorize(dirtyKey).then((result) => {
        dirtySettled = true;
        return result;
      });
      const revokedClient = reader();
      const revoked = authorize(dirtyKey, revokedClient);
      const unavailableGatewayMethods = new Set<string>();
      const unavailable = authorize(
        dirtyKey,
        client,
        bindSessionRowProjection({ ...context, unavailableGatewayMethods }, () => projection),
      );
      expect(await Promise.race([rowEntered.promise.then(() => "row"), joinedBulk.promise])).toBe(
        "row",
      );
      expect(dirtySettled).toBe(false);
      revokedClient.connect.scopes = [];
      unavailableGatewayMethods.add("sessions.describe");
      releaseRow.resolve();
      expect(await Promise.race([dirty, joinedBulk.promise])).toMatchObject({ error: null });
      expect(await revoked).toMatchObject({ error: { code: "FORBIDDEN" } });
      expect(await unavailable).toMatchObject({ error: { code: "UNAVAILABLE" } });
      expect(resumeBulk).toBeDefined();

      const current = openOpenClawAgentDatabase({ agentId: "main" });
      setParent(current, "agent:main:mismatch");
      sessionChanges.emit({
        sessionKey: dirtyKey,
        agentId: "main",
        storePath: current.path,
        factsInvalidated: true,
      });
      subscribeSessionMessageEvents.mockClear();
      const corruptRespond = await subscribe(dirtyKey, "corrupt-subscribe");
      expect(corruptRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("invalid persisted session row"),
        }),
      );
      expect(subscribeSessionMessageEvents).not.toHaveBeenCalled();
    } finally {
      releaseRow.resolve();
      const current = openOpenClawAgentDatabase({ agentId: "main" });
      setParent(current, null);
      resumeBulk?.();
      await Promise.allSettled(work);
      projection.dispose();
      releaseForeground();
    }
  });
});
