import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

describe("retained transcript sharing", () => {
  it.each([
    { method: "chat.history", narrow: false },
    { method: "chat.history", narrow: true },
    { method: "chat.startup", narrow: false },
    { method: "chat.startup", narrow: true },
  ] as const)(
    "rechecks invited $method readers after membership and draft changes (session-only: $narrow)",
    async ({ method, narrow }) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async (state) => {
          const viewer = ensureProfileForEmail("history-guest@example.test").id;
          const scopes = narrow
            ? ["operator.sessions.write" as const]
            : ["operator.read" as const, "operator.write" as const];
          const cfg: OpenClawConfig = {
            agents: { entries: { main: {} }, defaults: { model: "openai/gpt-5.6-sol" } },
            plugins: { enabled: false },
            gateway: {
              roles: {
                default: "guest",
                definitions: {
                  guest: { agents: "*", scopes, sessions: { others: "invited" } },
                },
              },
            },
          };
          await state.writeConfig(cfg);
          setRuntimeConfigSnapshot(cfg);
          const scope = {
            agentId: "main",
            sessionKey: "agent:main:invited-history",
            sessionId: "invited-history",
          };
          await upsertSessionEntryCore(scope, {
            sessionId: scope.sessionId,
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: "creator" },
          });
          const { messageId } = await appendTranscriptMessage(scope, {
            message: { role: "user", content: "Invitation-only message", timestamp: 1 },
          });
          const client = identifiedClient(viewer);
          client.connect.scopes = scopes;
          const context = await createHistoryReadContext({
            getRuntimeConfig: () => cfg,
            readChatStartupProjection: async () => undefined,
          });
          const call = async () => {
            const respond = vi.fn<RespondFn>();
            await expectDefined(
              chatHistoryHandlers[method],
              "history handler",
            )({
              params: { ...scope, messageId },
              client,
              context,
              respond,
              req: { type: "req", id: "invited-history", method },
              isWebchatConnect: () => false,
            });
            expect(respond).toHaveBeenCalledOnce();
            return respond.mock.calls[0]!;
          };
          const hidden = async () =>
            expect(await call()).toEqual([
              false,
              undefined,
              expect.objectContaining({ code: "INVALID_REQUEST" }),
            ]);
          const visible = async (phase: string) => {
            const [ok, payload, error] = await call();
            expect(ok, `${phase}: ${JSON.stringify(error)}`).toBe(true);
            expect(payload).toMatchObject({
              messages: [expect.objectContaining({ content: "Invitation-only message" })],
            });
          };
          await hidden();
          await addSessionMember(scope, { identityId: viewer, addedBy: "creator" });
          await visible("after invitation");
          await upsertSessionEntryCore(scope, { visibility: "draft" });
          await hidden();
          await upsertSessionEntryCore(scope, { visibility: "shared" });
          await visible("after restoring shared visibility");
          await removeSessionMember(scope, viewer);
          await hidden();
        },
      );
    },
  );

  it.each(["chat.history", "chat.startup"] as const)(
    "%s requires current sharing authority for a retained transcript",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { defaults: { model: "openai/gpt-5.6-sol" } },
          plugins: { enabled: false },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:retained-private-history",
          sessionId: "retained-private-history",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          displayName: "Private retained conversation",
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        const { messageId } = await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Private retained message", timestamp: 1 },
        });
        const client = identifiedClient("viewer");
        const readChatStartupProjection = vi.fn(async () => undefined);
        const context = await createHistoryReadContext({
          getRuntimeConfig: () => cfg,
          readChatStartupProjection,
        });
        const call = async () => {
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            chatHistoryHandlers[method],
            "history handler",
          )({
            params: { ...scope, messageId },
            client,
            context,
            respond,
            req: { type: "req", id: "retained-private-history", method },
            isWebchatConnect: () => false,
          });
          return respond;
        };
        const expectHidden = (respond: ReturnType<typeof vi.fn<RespondFn>>) => {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
        };
        expectHidden(await call());
        readChatStartupProjection.mockClear();
        expect(
          await deleteSessionEntryLifecycle({
            agentId: scope.agentId,
            storePath: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
            archiveTranscript: false,
          }),
        ).toMatchObject({ deleted: true });
        expectHidden(await call());
        expect(readChatStartupProjection).not.toHaveBeenCalled();
        client.connect.scopes = ["operator.admin"];
        expect(await call()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            messages: [expect.objectContaining({ content: "Private retained message" })],
          }),
        );
        readChatStartupProjection.mockImplementationOnce(async () => {
          client.connect.scopes = ["operator.read"];
          return undefined;
        });
        expectHidden(await call());
      });
    },
  );
});
