import fs from "node:fs/promises";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const target = { agentId: "main", sessionKey: "agent:main:file-turn", sessionId: "file-turn" };

describe("session file turn authority", () => {
  it("reads host files for a session writer and hides them from view-only callers", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      const sessionRoot = state.path("workspace");
      const filePath = state.path("outside.html");
      await fs.mkdir(sessionRoot, { recursive: true });
      await fs.writeFile(filePath, "<p>Outside workspace</p>");
      const viewer = roleClient("view", "file-viewer");
      const writer = roleClient("write", "file-writer");
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        spawnedCwd: sessionRoot,
        permissionMode: "full",
        visibility: "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: viewer.authenticatedUserProfile!.profileId,
        },
      });
      const foreign = { ...target, sessionKey: "agent:main:foreign-file", sessionId: "foreign" };
      await upsertSessionEntryCore(foreign, {
        sessionId: foreign.sessionId,
        updatedAt: 1,
        spawnedCwd: sessionRoot,
        permissionMode: "full",
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "another-person" },
      });
      const projection = await createSessionRowProjection({ cfg });
      const context = bindSessionRowProjection(
        createDirectChatContext({
          getRuntimeConfig: () => cfg,
          workerSessionPlacementService: createWorkerSessionPlacementStore(),
        }),
        () => projection,
      );
      try {
        for (const scenario of [
          { client: viewer, scopes: ["operator.sessions.write"], selected: target, allowed: true },
          {
            client: viewer,
            scopes: ["operator.sessions.write"],
            selected: foreign,
            allowed: false,
          },
          { client: viewer, scopes: ["operator.write"], selected: foreign, allowed: false },
          { client: writer, scopes: ["operator.read"], selected: foreign, allowed: false },
          { client: writer, scopes: ["operator.write"], selected: foreign, allowed: true },
        ]) {
          scenario.client.connect.scopes = scenario.scopes;
          const respond = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "file-read",
              method: "sessions.files.get",
              params: { sessionKey: scenario.selected.sessionKey, path: filePath },
            },
            client: scenario.client,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: sessionsFilesHandlers,
          });
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[0]).toBe(scenario.allowed);
          if (scenario.allowed) {
            expect(respond.mock.calls[0]?.[1]).toMatchObject({
              file: { content: "<p>Outside workspace</p>" },
            });
            expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("file.hash");
          } else {
            expect(respond.mock.calls[0]?.[2]).toMatchObject({
              details: { type: "session_file_not_found", reason: "outside_session_boundary" },
            });
          }
        }
        expect(context.chatAbortControllers.size).toBe(0);
        expect(context.chatQueuedTurns.size).toBe(0);
        expect(context.addChatRun).not.toHaveBeenCalled();
      } finally {
        projection.dispose();
      }
    });
  });

  it("keeps solo and admin incognito reads inside prepared authorization without synchronous SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {};
      const sessionRoot = state.path("workspace");
      const filePath = state.path("outside.html");
      await fs.mkdir(sessionRoot, { recursive: true });
      await fs.writeFile(filePath, "<p>Private host file</p>");
      const privateTarget = {
        ...target,
        sessionKey: "agent:main:dashboard:incognito-file-turn",
        sessionId: "private-file-turn",
      };
      const mainTarget = { ...target, sessionKey: "agent:main:main", sessionId: "main-file-turn" };
      for (const selected of [target, privateTarget, mainTarget]) {
        await upsertSessionEntryCore(selected, {
          sessionId: selected.sessionId,
          updatedAt: 1,
          spawnedCwd: sessionRoot,
          permissionMode: selected === privateTarget ? "full" : undefined,
          ...(selected === privateTarget ? { incognito: true } : {}),
        });
      }
      const projection = await createSessionRowProjection({ cfg });
      const prepare = projection.withPreparedExactRows.bind(projection);
      vi.spyOn(projection, "withPreparedExactRows").mockImplementation((queries, consume) =>
        prepare(queries, (read) => {
          const sql = observeSqliteReadSql(StatementSync.prototype);
          try {
            const result = consume(read);
            expect(sql.queries).toEqual([]);
            return result;
          } finally {
            sql.restore();
          }
        }),
      );
      const context = bindSessionRowProjection(
        createDirectChatContext({
          getRuntimeConfig: () => cfg,
          workerSessionPlacementService: createWorkerSessionPlacementStore(),
        }),
        () => projection,
      );
      try {
        for (const requestedKey of [target.sessionKey, privateTarget.sessionKey, "main"]) {
          for (const scopes of [["operator.write"], ["operator.admin"]]) {
            const respond = vi.fn();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: "private-file-read",
                method: "sessions.files.get",
                params: { sessionKey: requestedKey, path: filePath },
              },
              client: sharingPolicyClient({ scopes }),
              context,
              respond,
              isWebchatConnect: () => false,
              extraHandlers: sessionsFilesHandlers,
            });
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              expect.objectContaining({
                file: expect.objectContaining({
                  content: "<p>Private host file</p>",
                  path: await fs.realpath(filePath),
                }),
              }),
            );
            expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("file.hash");
          }
        }
        expect(projection.selectEntries().map((row) => row.key)).not.toContain(
          privateTarget.sessionKey,
        );
      } finally {
        projection.dispose();
      }
    });
  });

  it("rechecks scopes and the original session incarnation after file I/O", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {};
      const projection = await createSessionRowProjection({ cfg });
      const context = bindSessionRowProjection(
        createDirectChatContext({ getRuntimeConfig: () => cfg }),
        () => projection,
      );
      try {
        for (const changed of ["scope", "session"] as const) {
          await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
          const client = sharingPolicyClient({ scopes: ["operator.write"] });
          const respond = vi.fn();
          const publish = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: changed,
              method: "sessions.files.get",
              params: { sessionKey: target.sessionKey, path: "/outside.html" },
            },
            client,
            context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: {
              "sessions.files.get": async ({
                withSessionTurnAuthority,
                respond: publishResponse,
              }) => {
                if (!withSessionTurnAuthority) {
                  throw new Error("Missing router turn authority");
                }
                const entry = await withSessionTurnAuthority(target, (current) => current);
                expect(entry.sessionId).toBe(target.sessionId);
                if (changed === "scope") {
                  client.connect.scopes = ["operator.read"];
                } else {
                  await upsertSessionEntryCore(target, { sessionId: "replacement", updatedAt: 2 });
                }
                await withSessionTurnAuthority(target, () => {
                  publish();
                  publishResponse(true, { content: "private file" });
                });
              },
            },
          });
          expect(publish).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
        }
      } finally {
        projection.dispose();
      }
    });
  });
});
