import { expectDefined, safeParseJsonRecord } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { publishUserProfileAliasChange } from "../../state/user-profile-events.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { rolePolicyConfig, sharingPolicyClient } from "../session-sharing.test-utils.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  chatMetadataCommandFields,
  connectChatMetadataAccount,
  createChatMetadataHarness,
  createChatMetadataOwner,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";
import * as metadataProjection from "./chat-metadata-session-projection.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

async function invokeMetadata(
  context: GatewayRequestContext,
  sessionKey: string,
  respond: RespondFn,
  client: GatewayRequestHandlerOptions["client"] = null,
) {
  await handleChatMetadataRequest({
    params: { sessionKey },
    context,
    respond,
    client,
    req: { type: "req", id: "metadata", method: "chat.metadata" },
    isWebchatConnect: () => false,
  });
}
function expectSuperseded(error: unknown, access = false) {
  expect(error).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
  expect(error).toMatchObject({
    message: `${access ? "Chat metadata access" : "Session"} changed while preparing its metadata. Retry the request.`,
  });
}

it.each(
  (
    [
      ["tracked sibling update", true],
      ["raw sibling update", true],
      ["tracked selected update", true],
      ["raw selected update", true],
      ["rolled-back selected account", true],
      ["overlapping selected account", false],
      ["selected lifecycle change", false],
      ["identical recreation", true],
      ["replacement recreation", false],
      ["runtime config replacement", false],
      ["profile alias change", false],
    ] as const
  ).flatMap(([write, allowed]) => ["exact", "full"].map((cache) => ({ write, allowed, cache }))),
)("metadata read across $write with $cache cache", async ({ write, allowed, cache }) => {
  await withOpenClawTestState({ label: `metadata-${cache}-cache` }, async (state) => {
    const config = {};
    let runtimeConfig = config;
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const selected = { agentId: "main", sessionKey: "agent:main:metadata-selected" };
    const sibling = { agentId: "main", sessionKey: "agent:main:metadata-sibling" };
    const entry = { sessionId: "selected", lifecycleRevision: "initial", updatedAt: 1 };
    replaceSessionEntrySync(selected, entry);
    replaceSessionEntrySync(sibling, { sessionId: "sibling", updatedAt: 1 });
    await closeOpenClawAgentDatabasesAsync(state.root);
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    const database = openOpenClawAgentDatabase(selected);
    const sql = database.db.prepare.bind(database.db);
    const before = expectDefined(loadSessionEntry(selected), "selected entry");
    if (cache === "full") {
      listSessionEntriesCore({ ...selected, projection: "list" });
    }
    const metadata = { commands: [], models: [], swarmEnabled: false };
    const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async (scope) => {
      expect(scope.isCurrent?.()).toBe(true);
      const refresh =
        write === "overlapping selected account"
          ? expectDefined(scope.withCurrent, "metadata refresh")(() => metadata)
          : undefined;
      void refresh?.catch(() => {});
      if (write === "tracked sibling update" || write === "tracked selected update") {
        await upsertSessionEntryCore(write.includes("sibling") ? sibling : selected, {
          label: "changed",
        });
      } else if (write === "raw sibling update" || write === "raw selected update") {
        sql(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'changed') WHERE session_key = ?",
        ).run(write.includes("sibling") ? sibling.sessionKey : selected.sessionKey);
      } else if (write === "profile alias change") {
        publishUserProfileAliasChange();
      } else if (write === "runtime config replacement") {
        runtimeConfig = {};
      } else if (write === "selected lifecycle change") {
        await upsertSessionEntryCore(selected, { lifecycleRevision: "replacement" });
      } else if (write.endsWith("recreation")) {
        runOpenClawAgentWriteTransaction((current) => {
          current.db.exec("CREATE TEMP TABLE saved_node AS SELECT * FROM session_nodes");
          current.db
            .prepare("DELETE FROM session_nodes WHERE session_key = ?")
            .run(selected.sessionKey);
          current.db
            .prepare("INSERT INTO session_nodes SELECT * FROM saved_node WHERE session_key = ?")
            .run(selected.sessionKey);
          writeSessionEntry(current, selected.sessionKey, {
            ...before,
            sessionId: write === "replacement recreation" ? "replacement" : entry.sessionId,
          });
        }, selected);
      } else {
        const rollback = new Error("rollback account selection");
        const mutate = () =>
          runOpenClawAgentWriteTransaction((current) => {
            writeSessionEntry(current, selected.sessionKey, {
              ...before,
              authProfileOverride: "openai:changed",
            });
            if (write === "rolled-back selected account") {
              expect(scope.isCurrent?.()).toBe(false);
              expect(() => scope.assertCurrent?.()).toThrow(
                PreparedModelRuntimePublicationSupersededError,
              );
              throw rollback;
            }
          }, selected);
        if (write === "rolled-back selected account") {
          expect(mutate).toThrow(rollback);
        } else {
          mutate();
        }
      }
      if (allowed) {
        expect(scope.assertCurrent).toBeDefined();
        scope.assertCurrent!();
      }
      return refresh ? await refresh : metadata;
    });
    const respond = vi.fn<RespondFn>();
    const error = await invokeMetadata(
      createDirectChatContext({ getRuntimeConfig: () => runtimeConfig, readChatMetadata }),
      selected.sessionKey,
      respond,
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(readChatMetadata).toHaveBeenCalledOnce();
    if (allowed) {
      expect(error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(true, metadata);
      expect(loadSessionEntry(selected)).toEqual(
        write === "tracked selected update" || write === "raw selected update"
          ? { ...before, label: "changed" }
          : before,
      );
    } else {
      expectSuperseded(
        error,
        write === "runtime config replacement" || write === "profile alias change",
      );
      expect(respond).not.toHaveBeenCalled();
    }
    await cleanupSessionStateForTest({ stateDir: state.stateDir });
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  });
});

it.each([
  ["read acknowledgment", "lastReadAt", false, true],
  ["local visibility change", "visibility", false, false],
  ["committed visibility change", "visibility", true, false],
  ["local saved-account change", "authProfileOverride", false, false],
  ["committed saved-account change", "authProfileOverride", true, false],
] as const)(
  "revalidates %s before preparing private chat metadata",
  (_name, field, committed, allowed) =>
    withOpenClawTestState(
      {
        label: "metadata-read-acknowledgment",
        env: WITHOUT_OPENAI_ENV_AUTH,
        prepareProfileCatalog: true,
      },
      async (state) => {
        const config = { ...createOpenAIChatMetadataConfig(), ...rolePolicyConfig() };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const owner = ensureProfileForEmail("metadata-session-owner@example.test");
        const viewer = ensureProfileForEmail("metadata-session-viewer@example.test");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const authProfileId = connectChatMetadataAccount(owner.id);
        const client = sharingPolicyClient({ user: viewer.id });
        const selected = { agentId: "main", sessionKey: "agent:main:metadata-read-marker" };
        replaceSessionEntrySync(selected, {
          sessionId: "read-marker-session",
          lifecycleRevision: "read-marker-lifecycle",
          sessionStartedAt: 1,
          updatedAt: 1,
          lastReadAt: 1,
          label: "read-marker-label",
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: owner.id },
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          authProfileOverride: authProfileId,
          authProfileOverrideSource: "user",
          toolOverrides: { webSearch: false },
        });
        await closeOpenClawAgentDatabasesAsync(state.root);
        const database = openOpenClawAgentDatabase(selected);
        const sql = database.db.prepare.bind(database.db);
        const before = expectDefined(loadSessionEntry(selected), "selected entry");
        const readRow = () =>
          expectDefined(
            sql("SELECT * FROM session_nodes WHERE session_key = ?").get(selected.sessionKey),
            "selected row",
          );
        const beforeRow = readRow();
        const beforePayload = expectDefined(
          safeParseJsonRecord(String(beforeRow.entry_json)),
          "selected payload",
        );
        const prepareProjection = vi.spyOn(
          metadataProjection,
          "prepareChatMetadataModelProjection",
        );
        const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
        harness.setOwner(
          createChatMetadataOwner(config, "gpt-5.6-luna", {}, "openai", "openai-chatgpt-responses"),
        );
        const context = createDirectChatContext({
          getRuntimeConfig: () => config,
          readChatMetadata: harness.runtime.read,
        });
        const invoke = (respond: RespondFn) =>
          invokeMetadata(context, selected.sessionKey, respond, client);
        let release: (() => void) | undefined;
        let pending: Promise<void> | undefined;
        const heldRead = async (changeEntry: boolean) => {
          const entered = createDeferred();
          const gate = createDeferred();
          release = () => gate.resolve();
          harness.buildCommands.mockImplementationOnce(async () => {
            entered.resolve();
            await gate.promise;
            return { commands: [{ ...chatMetadataCommandFields, name: "help" }] };
          });
          const respond = vi.fn<RespondFn>();
          const request = invoke(respond);
          pending = request;
          void request.catch(() => {});
          await awaitGateBeforeSettlement(
            entered.promise,
            request,
            "Metadata completed before the preparation hold",
          );
          try {
            if (changeEntry && allowed) {
              await patchSessionEntryCore(selected, () => ({ lastReadAt: 2 }), {
                preserveActivity: true,
                skipMaintenance: true,
              });
            } else if (changeEntry && committed) {
              runOpenClawAgentWriteTransaction((current) => {
                writeSessionEntry(current, selected.sessionKey, {
                  ...before,
                  [field]: field === "visibility" ? "draft" : "openai:replacement",
                });
              }, selected);
            } else if (changeEntry) {
              sql(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
              ).run(
                `$.${field}`,
                field === "visibility" ? "draft" : "openai:replacement",
                selected.sessionKey,
              );
            }
            if (!changeEntry || allowed) {
              expect(loadSessionEntry(selected)).toEqual(
                changeEntry ? { ...before, lastReadAt: 2 } : before,
              );
              expect(readRow()).toEqual(
                changeEntry
                  ? {
                      ...beforeRow,
                      entry_json: JSON.stringify({ ...beforePayload, lastReadAt: 2 }),
                      last_read_at: 2,
                    }
                  : beforeRow,
              );
            }
          } finally {
            gate.resolve();
          }
          const error = await request.then(
            () => undefined,
            (cause: unknown) => cause,
          );
          return { respond, error };
        };
        try {
          await harness.runtime.refresh();
          const control = await heldRead(false);
          expect(control.error).toBeUndefined();
          expect(control.respond).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({
              commands: [{ ...chatMetadataCommandFields, name: "help" }],
              models: [expect.objectContaining({ id: "gpt-5.6-luna", provider: "openai" })],
            }),
          );
          expect(prepareProjection).toHaveBeenCalledWith(
            expect.objectContaining({ preferredProfileId: authProfileId }),
          );
          harness.runtime.invalidate();
          await harness.runtime.refresh();
          prepareProjection.mockClear();
          const changed = await heldRead(true);
          if (!allowed) {
            expect(prepareProjection).not.toHaveBeenCalled();
            expectSuperseded(changed.error);
            expect(changed.respond).not.toHaveBeenCalled();
          } else {
            const fresh = vi.fn<RespondFn>();
            await invoke(fresh);
            // The fresh source agrees before checking the held request's result.
            expect(fresh.mock.calls).toEqual(control.respond.mock.calls);
            expect(changed.error).toBeUndefined();
            expect(changed.respond.mock.calls).toEqual(control.respond.mock.calls);
          }
          await closeOpenClawAgentDatabasesAsync(state.root);
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        } finally {
          release?.();
          await pending?.catch(() => {});
          await harness.runtime.stop();
          prepareProjection.mockRestore();
        }
      },
    ),
);
