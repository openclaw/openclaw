import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { boardStore } from "../board-store.js";
import { progressCardStore } from "../progress-card-store.js";
import { handleGatewayRequest } from "../server-methods.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createBoardHarness } from "./board.test-support.js";
import { progressCardHandlers } from "./progress-card.js";
import { profileSessionEntry } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

const methods = [
  "board.update",
  "board.widget.put",
  "board.widget.grant",
  "progressCard.put",
] as const;
const variants = <T extends string>(change: T, selected: readonly (typeof methods)[number][]) =>
  selected.map((method) => ({ method, change }));
const stateOptions = { scenario: "minimal", prepareProfileCatalog: true } as const;
const scopes = ["operator.read", "operator.write", "operator.approvals"] as const;

it.each([
  ...variants("allow", methods),
  ...variants("guard", methods),
  ...variants(
    "allow-worker",
    methods.filter((method) => method.startsWith("board.")),
  ),
  ...variants("abort", ["board.update", "board.widget.grant", "progressCard.put"]),
  ...variants("route", ["board.widget.put", "progressCard.put"]),
  ...variants("lifecycle", ["progressCard.put"]),
])("queues registered $method behind a native reservation ($change)", ({ method, change }) =>
  withOpenClawTestState(stateOptions, async () => {
    const cold = change === "abort";
    let cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    };
    cfg.gateway!.roles!.definitions!.view!.scopes = [...scopes];
    setRuntimeConfigSnapshot(cfg, cfg);
    const target = { sessionKey: "global", agentId: "work" };
    const client = { ...roleClient("view", "admission-owner"), connId: "admission-owner" };
    client.connect.scopes = [...scopes];
    const entry = {
      ...profileSessionEntry("admission-session", 1, client.authenticatedUserProfile!.profileId),
      lifecycleRevision: "before",
      visibility: "draft" as const,
    };
    await upsertSessionEntryCore(target, entry);
    const widget = {
      name: "admission",
      content: { kind: "html" as const, html: "<p>admitted</p>" },
    };
    const previous =
      method === "board.widget.grant"
        ? await boardStore.putWidget({
            ...target,
            ...widget,
            declared: { netOrigins: ["https://example.test"] },
          })
        : undefined;
    const previousWidget = previous?.widgets[0];
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    // Only progress cards remain optional; their first-use DDL shares write admission.
    if (method === "progressCard.put") {
      database.db.exec("DROP TABLE session_progress_cards;");
    }
    if (cold) {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    }
    const readRows = (sql: string, ...bindings: string[]) =>
      withOpenClawAgentDatabaseReadOnly(({ db }) => db.prepare(sql).all(...bindings), database);
    const databaseState = () => ({
      tables: readRows(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('board_widgets', 'board_tabs', 'session_progress_cards') ORDER BY name",
      ),
      tabs: readRows("SELECT * FROM board_tabs WHERE session_key = ?", target.sessionKey),
      widgets: readRows("SELECT * FROM board_widgets WHERE session_key = ?", target.sessionKey),
    });
    const previousState = databaseState();
    const board = createBoardHarness(undefined, {}, boardStore, {
      getRuntimeConfig: () => cfg,
    });
    const respond = vi.fn<RespondFn>();
    const params = {
      ...target,
      ...(method === "board.update"
        ? { ops: [{ kind: "tab_create", tabId: "notes", title: "Notes" }] }
        : method === "board.widget.grant"
          ? {
              name: "admission",
              decision: "rejected",
              revision: previousWidget?.revision,
              instanceId: previousWidget?.instanceId,
            }
          : method === "board.widget.put"
            ? widget
            : { markdown: "admitted" }),
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const retiredError = new Error("request owner retired");
    const abortError = new Error("request closed");
    let requestCurrent = true;
    const replacementPath = path.join(path.dirname(database.path), "replacement.sqlite");
    const mutation =
      method === "progressCard.put"
        ? vi.spyOn(progressCardStore, "put")
        : vi.spyOn(
            boardStore,
            method === "board.update"
              ? "applyOps"
              : method === "board.widget.grant"
                ? "grant"
                : "putWidget",
          );
    let requestFailure: { error: unknown } | undefined;
    let inGrant = false;
    const stages: string[] = [];
    const grantReads: string[] = [];
    const reads = observeHostDataSql((sql) => {
      if (inGrant && /\b(?:session_nodes|session_members)\b/iu.test(sql)) {
        grantReads.push(sql);
      }
    });
    const grants = probe.admission(admission, (admissionRequest, grant, admit) => {
      inGrant = admissionRequest.stage === "transaction" || admissionRequest.stage === "commit";
      if (inGrant) {
        stages.push(admissionRequest.stage);
      }
      try {
        admit(admissionRequest, grant);
      } finally {
        inGrant = false;
      }
    });
    const handlers = { ...board.handlers, ...progressCardHandlers };
    const handler = handlers[method]!;
    const expectUnchanged = () => {
      expect(databaseState()).toEqual(previousState);
      expect(board.broadcast).not.toHaveBeenCalled();
    };
    const request = handleGatewayRequest({
      req: { type: "req", id: "admission", method, params },
      client,
      context: board.context,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: {
        ...handlers,
        [method]: async (invocation) => {
          // Authorization may read through the same writer queue before handler entry.
          const { mutationRequest: pendingMutation } = await runOpenClawAgentWorkerWrite(
            database,
            async () => {
              const mutationRequest = Promise.resolve(handler(invocation));
              // Observe early failure while reserved; the await below still propagates it.
              void mutationRequest.catch(() => {});
              entered.resolve();
              await release.promise;
              return { mutationRequest };
            },
          );
          await pendingMutation;
        },
      },
      signal: controller.signal,
      sessionMutationCommitGuard:
        change === "allow-worker"
          ? undefined
          : () => {
              if (!requestCurrent) {
                throw retiredError;
              }
            },
    }).catch((error: unknown) => {
      requestFailure = { error };
    });
    try {
      await Promise.race([entered.promise, request]);
      expect(mutation).toHaveBeenCalledOnce();
      expectUnchanged();
      expect(respond).not.toHaveBeenCalled();
      if (change === "abort") {
        controller.abort(abortError);
      } else if (change === "guard") {
        requestCurrent = false;
      } else if (change === "route") {
        cfg = { ...cfg, session: { store: replacementPath } };
        setRuntimeConfigSnapshot(cfg, cfg);
      } else if (change === "lifecycle") {
        replaceSessionEntrySync(
          { ...target, storePath: database.path },
          { ...entry, lifecycleRevision: "after", updatedAt: 2 },
        );
      }
    } finally {
      release.resolve();
      await request;
      mutation.mockRestore();
      grants.mockRestore();
      reads.restore();
    }
    if (requestFailure) {
      if (change === "guard" || change === "abort") {
        expect(requestFailure.error).toBe(change === "guard" ? retiredError : abortError);
      } else if (change === "lifecycle") {
        expect(requestFailure.error).toBeInstanceOf(SessionMutationFactsUnavailableError);
      } else {
        throw requestFailure.error;
      }
    }
    if (change === "allow-worker") {
      expect(stages).toEqual(expect.arrayContaining(["transaction", "commit"]));
      expect(grantReads).toEqual([]);
    }
    if (change !== "allow" && change !== "allow-worker") {
      expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
      expectUnchanged();
      expect(fs.existsSync(replacementPath)).toBe(false);
      if (cold) {
        expect(getOpenClawAgentDatabaseIfOpen(database)).toBeUndefined();
      }
      return;
    }
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const actual =
      method === "progressCard.put"
        ? await progressCardStore.get(target.sessionKey, target.agentId)
        : await boardStore.getSnapshot(target);
    expect(actual).toMatchObject(
      {
        "board.update": { tabs: [{ tabId: "notes", title: "Notes" }] },
        "board.widget.put": { widgets: [{ name: "admission", revision: 1 }] },
        "board.widget.grant": {
          widgets: [{ name: "admission", revision: 1, grantState: "rejected" }],
        },
        "progressCard.put": { markdown: "admitted", revision: 1 },
      }[method],
    );
  }),
);
