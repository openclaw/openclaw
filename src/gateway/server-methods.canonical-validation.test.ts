import { symlinkSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.sqlite-initial-entry.js";
import * as readiness from "../config/sessions/session-canonical-validation-readiness.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  authorizeGatewayRequestPreDispatch,
  createRequestGatewayMethodRegistry,
  handleGatewayRequest,
} from "./server-methods.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as rowFacts from "./session-row-projection-read.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("keeps prepared authorization bound through a configured database alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = "agent:main:alias";
    ensureSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "alias", updatedAt: 1 },
    );
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
      expect(result.error).toBeNull();
      expect(result.sessionMutationAuthorization?.admittedTarget?.sessionId).toBe("alias");
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
      const sessionKey = "agent:main:canonical-readiness";
      ensureSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "canonical-readiness",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      ensureSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:unrelated-invalid" },
        { sessionId: "unrelated-invalid", updatedAt: 1 },
      );
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
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "canonical-target",
          method,
          params: method === "sessions.patch" ? { key: sessionKey } : { sessionKey },
        },
        respond,
        client: sharingPolicyClient({ user: "member", scopes: ["operator.write"] }),
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
        extraHandlers: { [method]: handler },
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, { allowed: true });
    });
  },
);

it("authorizes exact rows independently of bulk validation and fences dirty rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      database.db.exec(`UPDATE session_nodes SET entry_json = entry_json || ' '
        WHERE session_key != 'agent:main:clean'; UPDATE session_nodes SET entry_valid = 1`);
      // Reopening creates an unadmitted reader, as after startup or idle reader retirement.
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      sessionChanges.emitBatch(
        Array.from({ length: 1000 }, (_, i) => ({
          sessionKey: `agent:main:dirty-${i}`,
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
      const context = bindSessionRowProjection(
        {
          getRuntimeConfig: () => ({}),
          subscribeSessionMessageEvents: vi.fn(),
          logGateway: { warn: vi.fn(), error: vi.fn() },
        } as unknown as GatewayRequestContext,
        () => projection,
      );
      const methodRegistry = createRequestGatewayMethodRegistry();
      const client = sharingPolicyClient({ user: "reader", scopes: ["operator.sessions.read"] });
      const authorize = (key?: string, requestClient = client, requestContext = context) => {
        const result = authorizeGatewayRequestPreDispatch({
          method: key ? "sessions.messages.subscribe" : "sessions.list",
          requestParams: key ? { key } : {},
          client: requestClient,
          context: requestContext,
          methodRegistry,
        });
        work.push(result);
        return result;
      };
      const cleanReads = Promise.all([authorize("agent:main:clean"), authorize()]);
      expect(await Promise.race([cleanReads, joinedBulk.promise])).toEqual([
        expect.objectContaining({ error: null }),
        expect.objectContaining({ error: null }),
      ]);
      const parse = vi.spyOn(JSON, "parse");
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "clean-subscribe",
          method: "sessions.messages.subscribe",
          params: { key: "agent:main:clean" },
        },
        client: { ...client, connId: "clean-subscribe" },
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionSubscriptionHandlers,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        { subscribed: true, key: "agent:main:clean" },
        undefined,
      );
      expect(
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"dirty-')),
      ).toHaveLength(0);
      parse.mockRestore();
      let dirtySettled = false;
      const dirty = authorize("agent:main:dirty-0").then((result) => {
        dirtySettled = true;
        return result;
      });
      const revokedClient = sharingPolicyClient({
        user: "reader",
        scopes: ["operator.sessions.read"],
      });
      const revoked = authorize("agent:main:dirty-0", revokedClient);
      const unavailableGatewayMethods = new Set<string>();
      const unavailable = authorize(
        "agent:main:dirty-0",
        client,
        bindSessionRowProjection({ ...context, unavailableGatewayMethods }, () => projection),
      );
      expect(await Promise.race([rowEntered.promise.then(() => "row"), joinedBulk.promise])).toBe(
        "row",
      );
      expect(dirtySettled).toBe(false);
      revokedClient.connect.scopes = [];
      unavailableGatewayMethods.add("sessions.messages.subscribe");
      releaseRow.resolve();
      expect(await Promise.race([dirty, joinedBulk.promise])).toMatchObject({ error: null });
      expect(await revoked).toMatchObject({ error: { code: "FORBIDDEN" } });
      expect(await unavailable).toMatchObject({ error: { code: "UNAVAILABLE" } });
      expect(resumeBulk).toBeDefined();

      const current = openOpenClawAgentDatabase({ agentId: "main" });
      current.db.exec(
        "UPDATE session_nodes SET parent_session_key = 'agent:main:mismatch' WHERE session_key = 'agent:main:dirty-0'",
      );
      sessionChanges.emit({
        sessionKey: "agent:main:dirty-0",
        agentId: "main",
        storePath: current.path,
        factsInvalidated: true,
      });
      await expect(authorize("agent:main:dirty-0")).rejects.toThrow(
        "invalid persisted session row",
      );
    } finally {
      releaseRow.resolve();
      const current = openOpenClawAgentDatabase({ agentId: "main" });
      current.db.exec(
        "UPDATE session_nodes SET parent_session_key = NULL WHERE session_key = 'agent:main:dirty-0'",
      );
      resumeBulk?.();
      await Promise.allSettled(work);
      projection.dispose();
      releaseForeground();
    }
  });
});
