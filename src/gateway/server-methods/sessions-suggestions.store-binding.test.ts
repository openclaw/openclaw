import { realpathSync, symlinkSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { listSessionSuggestions } from "../../config/sessions/session-suggestion-store.read.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import { getSessionSuggestionTestMocks } from "./sessions-suggestions.test-mocks.js";
import {
  call,
  client,
  context,
  registerSessionSuggestionTestLifecycle,
  responseSuggestionId,
} from "./sessions-suggestions.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);
beforeEach(() => mocks.afterSuggestionClaim.mockReset());

describe("session suggestion store binding", () => {
  it.each([
    ["directory-alias", "send"],
    ["directory-alias", "queue"],
    ["incognito", "send"],
    ["incognito", "queue"],
  ] as const)(
    "dispatches a %s suggestion with %s through its original store",
    async (layout, resolution) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const agentId = "ops";
        const incognito = layout === "incognito";
        const key = incognito
          ? "agent:ops:dashboard:incognito-suggestions-binding"
          : "agent:ops:aliased-suggestions";
        const physicalStorePath = incognito
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })
          : state.statePath("original", "session.sqlite");
        const scope = { agentId, sessionKey: key, storePath: physicalStorePath, env: state.env };
        const sessionId = "session-store-binding";
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1,
          ...(incognito ? { incognito: true } : {}),
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        });
        const cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId } },
            entries: { ops: {} },
          },
        };
        const aliasStorePath = state.statePath("selected", "session.sqlite");
        if (!incognito) {
          const nativeTarget = resolveSqliteTargetFromSessionStorePath(physicalStorePath, scope);
          await closeOpenClawAgentDatabaseByPathAsync(nativeTarget.path, nativeTarget.agentId);
          symlinkSync(state.statePath("original"), state.statePath("selected"), "junction");
          cfg.session = { store: aliasStorePath };
          // Gateway startup registers its writable store before capturing request authority.
          const aliasTarget = resolveSqliteTargetFromSessionStorePath(aliasStorePath, scope);
          if (!aliasTarget.agentId) {
            throw new Error("expected the seeded alias database owner");
          }
          openOpenClawAgentDatabase({
            agentId: aliasTarget.agentId,
            path: aliasTarget.path,
            env: state.env,
          });
        }
        await state.writeConfig(cfg);
        const requestContext = context(vi.fn(), cfg);
        const requester = client("owner", "Owner", incognito);
        const added = await call(
          "session.suggestions.add",
          { sessionKey: key, agentId, text: "Keep this suggestion bound to its original store." },
          requester,
          requestContext,
        );
        expect(added.responses[0]).toMatchObject([
          true,
          { suggestion: { sessionKey: key, agentId, state: "pending" } },
        ]);
        const id = responseSuggestionId(added);
        const listed = await call(
          "session.suggestions.list",
          { sessionKey: key, agentId },
          requester,
          requestContext,
        );
        expect(listed.responses).toEqual([
          [
            true,
            {
              role: incognito ? "admin" : "owner",
              suggestions: [expect.objectContaining({ id, sessionKey: key, agentId })],
            },
          ],
        ]);
        await withReadySessionRows(
          requireSessionRowProjection(requestContext),
          () => [{ key, agentId }],
          (read) => {
            const row = read.describe({ key, agentId });
            expect(row).toBeDefined();
            if (!row) {
              throw new Error("expected the original suggestion row");
            }
            if (incognito) {
              expect(row.storeTarget.storePath).toBe(physicalStorePath);
              expect(read.readSource(row)).toBeUndefined();
            } else {
              expect(row.storeTarget.storePath).toBe(aliasStorePath);
              expect(read.readSource(row)?.path).toBe(realpathSync(physicalStorePath));
              expect(read.readSource(row)?.path).not.toBe(row.storeTarget.storePath);
            }
          },
        );

        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey: key, agentId, id, resolution },
          requester,
          requestContext,
        );

        expect(resolved.responses).toHaveLength(1);
        expect(resolved.responses[0]).toMatchObject([
          true,
          { suggestion: { id, sessionKey: key, agentId, state: "accepted" } },
        ]);
        expect(mocks.handleChatSend).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            params: expect.objectContaining({
              sessionKey: key,
              sessionId,
              agentId,
              queueMode: resolution === "queue" ? "followup" : "steer",
              idempotencyKey: `session-suggestion:${id}`,
            }),
          }),
        );
        expect(await listSessionSuggestions(scope)).toEqual([
          expect.objectContaining({ id, state: "accepted" }),
        ]);
      });
    },
  );
});
