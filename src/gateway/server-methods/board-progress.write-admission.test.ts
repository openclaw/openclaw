import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { boardStore } from "../board-store.js";
import { progressCardStore } from "../progress-card-store.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createBoardHarness } from "./board.test-support.js";
import { createProgressCardHandlers } from "./progress-card.js";
import type { RespondFn } from "./types.js";

const methods = [
  "board.update",
  "board.widget.put",
  "board.widget.grant",
  "progressCard.put",
] as const;
const cases = methods.flatMap((method) =>
  (["allow", "abort", "guard", "route"] as const).map((change) => ({
    method,
    change,
    cold: false,
  })),
);

describe("board and progress-card database write admission", () => {
  it.each([
    ...cases,
    ...methods.map((method) => ({ method, change: "abort" as const, cold: true })),
    { method: "progressCard.put" as const, change: "lifecycle" as const, cold: false },
  ])(
    "queues registered $method behind a native reservation ($change, cold=$cold)",
    async ({ method, change, cold }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        let cfg: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        };
        cfg.gateway!.roles!.definitions!.view!.scopes = [
          "operator.read",
          "operator.write",
          "operator.approvals",
        ];
        setRuntimeConfigSnapshot(cfg, cfg);
        const target = { sessionKey: "global", agentId: "work" };
        const client = { ...roleClient("view", "admission-owner"), connId: "admission-owner" };
        client.connect.scopes = ["operator.read", "operator.write", "operator.approvals"];
        const entry = {
          sessionId: "admission-session",
          lifecycleRevision: "before",
          updatedAt: 1,
          visibility: "draft" as const,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: client.authenticatedUserProfile!.profileId,
          },
        };
        await upsertSessionEntryCore(target, entry);
        const previous =
          method === "board.widget.grant"
            ? await boardStore.putWidget({
                ...target,
                name: "admission",
                content: { kind: "html", html: "<p>admitted</p>" },
                declared: { netOrigins: ["https://example.test"] },
              })
            : undefined;
        const previousSnapshot = previous ? await boardStore.getSnapshot(target) : undefined;
        const database = openOpenClawAgentDatabase({ agentId: target.agentId });
        // The first-use schema transaction must respect the same reservation as its data write.
        if (!previous) {
          database.db.exec(
            "DROP TABLE board_widgets; DROP TABLE board_tabs; DROP TABLE session_progress_cards;",
          );
        }
        if (cold) {
          closeOpenClawAgentDatabaseByPath(database.path);
        }
        const tables = () =>
          withOpenClawAgentDatabaseReadOnly(
            ({ db }) =>
              db
                .prepare(
                  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('board_widgets', 'board_tabs', 'session_progress_cards') ORDER BY name",
                )
                .all(),
            database,
          );
        const previousTables = tables();
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
                  revision: previous?.widgets[0]?.revision,
                  instanceId: previous?.widgets[0]?.instanceId,
                }
              : method === "board.widget.put"
                ? { name: "admission", content: { kind: "html", html: "<p>admitted</p>" } }
                : { markdown: "admitted" }),
        };
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const controller = new AbortController();
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
        let request: Promise<void> | undefined;
        const reservation = runOpenClawAgentWorkerWrite(database, async () => {
          request = handleGatewayRequest({
            req: { type: "req", id: "admission", method, params },
            client,
            context: board.context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: { ...board.handlers, ...createProgressCardHandlers() },
            signal: controller.signal,
            sessionMutationCommitGuard: () => {
              if (!requestCurrent) {
                throw new Error("request owner retired");
              }
            },
          });
          entered.resolve();
          await release.promise;
        });
        try {
          await entered.promise;
          await setImmediate();
          expect(tables()).toEqual(previous ? previousTables : { found: true, value: [] });
          expect(respond).not.toHaveBeenCalled();
          expect(board.broadcast).not.toHaveBeenCalled();
          expect(mutation).toHaveBeenCalledOnce();
          if (change === "abort") {
            controller.abort(new Error("request closed"));
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
          await reservation;
          await request;
          mutation.mockRestore();
        }
        if (change !== "allow") {
          expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
          expect(board.broadcast).not.toHaveBeenCalled();
          expect(tables()).toEqual(previous ? previousTables : { found: true, value: [] });
          if (previousSnapshot) {
            const unchanged = withOpenClawAgentDatabaseReadOnly(
              ({ db }) =>
                db
                  .prepare(
                    "SELECT revision, grant_state FROM board_widgets WHERE session_key = ? AND name = ?",
                  )
                  .get(target.sessionKey, "admission"),
              database,
            );
            expect(unchanged).toEqual({
              found: true,
              value: {
                revision: previousSnapshot.widgets[0]?.revision,
                grant_state: previousSnapshot.widgets[0]?.grantState,
              },
            });
          }
          expect(fs.existsSync(replacementPath)).toBe(false);
          if (cold) {
            expect(getOpenClawAgentDatabaseIfOpen(database)).toBeUndefined();
          }
          return;
        }
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        if (method === "board.update") {
          expect((await boardStore.getSnapshot(target)).tabs).toEqual([
            expect.objectContaining({ tabId: "notes", title: "Notes" }),
          ]);
        } else if (method === "board.widget.put" || method === "board.widget.grant") {
          expect((await boardStore.getSnapshot(target)).widgets).toEqual([
            expect.objectContaining({
              name: "admission",
              revision: 1,
              ...(method === "board.widget.grant" ? { grantState: "rejected" } : {}),
            }),
          ]);
        } else {
          expect(await progressCardStore.get(target.sessionKey, target.agentId)).toMatchObject({
            markdown: "admitted",
            revision: 1,
          });
        }
      });
    },
  );
});
