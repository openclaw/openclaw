import { expectDefined, safeParseJsonRecord } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  assignSessionOwner,
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
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
import { WITHOUT_OPENAI_ENV_AUTH } from "../test-helpers.env.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  chatMetadataCommandFields,
  connectChatMetadataAccount,
  createChatMetadataHarness,
  createChatMetadataOwner,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";
import * as metadataProjection from "./chat-metadata-session-projection.js";
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

const cases = [
  { write: "raw sibling update", allowed: true },
  { write: "sibling cache replacement", allowed: true },
  { write: "canonical sibling owner", allowed: true },
  { write: "canonical sibling participant", allowed: true },
  { write: "compound sibling owner", allowed: true },
  { write: "compound sibling participant", allowed: true },
  { write: "overlapping selected account", allowed: false },
  { write: "selected lifecycle change", allowed: false },
  { write: "rolled-back selected account", allowed: true },
  { write: "committed selected identical recreation", allowed: true },
  { write: "committed selected fully restored recreation", allowed: true },
  { write: "committed selected recreated sessionId", allowed: false },
  { write: "committed selected recreated lifecycle", allowed: false },
  { write: "runtime config replacement", allowed: false },
  { write: "profile alias change", allowed: false },
] as const;

it.each(cases)("metadata read across $write", ({ write, allowed }) =>
  withOpenClawTestState({ label: "metadata-cache-boundary" }, async (state) => {
    const config = {};
    let runtimeConfig = config;
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const selected = { agentId: "main", sessionKey: "agent:main:metadata-selected" };
    const sibling = { agentId: "main", sessionKey: "agent:main:metadata-sibling" };
    replaceSessionEntrySync(selected, {
      sessionId: "selected",
      lifecycleRevision: "selected-original",
      sessionStartedAt: 1,
      label: "selected",
      updatedAt: 1,
    });
    if (write.includes("sibling")) {
      replaceSessionEntrySync(sibling, { sessionId: "sibling", label: "sibling", updatedAt: 1 });
      // Prepare side tables before capturing the selected metadata read.
      assignSessionOwner(sibling, {
        owner: { type: "agent", id: "main" },
        assignedBy: { type: "agent", id: "main" },
        assignedAt: 1,
      });
      recordSessionParticipant(sibling, {
        identity: { type: "agent", id: "seed-participant" },
        promptedAt: 1,
      });
    }
    await closeOpenClawAgentDatabasesAsync(state.root);
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    const before = expectDefined(loadSessionEntry(selected), "selected session entry");
    if (write === "sibling cache replacement") {
      listSessionEntriesCore({ ...selected, projection: "list" });
    }
    const changeSibling = () => {
      if (write.endsWith("participant")) {
        expect(
          recordSessionParticipant(sibling, {
            identity: { type: "agent", id: "second-participant" },
            promptedAt: 2,
          }),
        ).toBe("inserted");
      } else {
        expect(
          assignSessionOwner(sibling, {
            owner: { type: "agent", id: "other" },
            assignedBy: { type: "agent", id: "main" },
            assignedAt: 2,
          }),
        ).not.toBeNull();
      }
    };
    const writeSelected = (
      current: Parameters<typeof writeSessionEntry>[0],
      patch: Partial<typeof before>,
    ) => writeSessionEntry(current, selected.sessionKey, { ...before, ...patch });
    const metadata = { commands: [], models: [], swarmEnabled: false };
    const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async (scope) => {
      expect(scope.isCurrent?.()).toBe(true);
      const refresh =
        write === "overlapping selected account"
          ? expectDefined(scope.withCurrent, "metadata refresh")(() => metadata)
          : undefined;
      void refresh?.catch(() => {});
      if (write === "raw sibling update" || write === "sibling cache replacement") {
        openOpenClawAgentDatabase(sibling)
          .db.prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
          .run(sibling.sessionKey);
        if (write === "sibling cache replacement") {
          listSessionEntriesCore({ ...sibling, projection: "list" });
        }
      } else if (write.startsWith("compound sibling")) {
        runOpenClawAgentWriteTransaction((current) => {
          writeSessionEntry(current, sibling.sessionKey, {
            sessionId: "sibling",
            label: "compound update",
            updatedAt: 2,
          });
          changeSibling();
        }, sibling);
      } else if (write.startsWith("canonical sibling")) {
        changeSibling();
      } else if (write === "overlapping selected account") {
        runOpenClawAgentWriteTransaction((current) => {
          writeSelected(current, { authProfileOverride: "openai:changed-during-refresh" });
        }, selected);
      } else if (write === "runtime config replacement") {
        runtimeConfig = {};
      } else if (write === "profile alias change") {
        publishUserProfileAliasChange();
      } else if (write === "rolled-back selected account") {
        const rollback = new Error("roll back side metadata");
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            writeSelected(current, { authProfileOverride: "openai:changed-during-transaction" });
            expect(scope.isCurrent?.()).toBe(false);
            expect(() => scope.assertCurrent?.()).toThrow(
              PreparedModelRuntimePublicationSupersededError,
            );
            throw rollback;
          }, selected),
        ).toThrow(rollback);
      } else if (write === "selected lifecycle change") {
        await upsertSessionEntryCore(selected, { lifecycleRevision: "selected-replaced" });
      } else {
        runOpenClawAgentWriteTransaction((current) => {
          const prepare = current.db.prepare.bind(current.db);
          const readRow = () =>
            prepare("SELECT rowid, * FROM session_nodes WHERE session_key = ?").get(
              selected.sessionKey,
            );
          const beforeRow = readRow();
          current.db.exec("CREATE TEMP TABLE saved_node AS SELECT * FROM session_nodes;");
          prepare("DELETE FROM session_nodes WHERE session_key = ?").run(selected.sessionKey);
          prepare("INSERT INTO session_nodes SELECT * FROM saved_node WHERE session_key = ?").run(
            selected.sessionKey,
          );
          if (write === "committed selected fully restored recreation") {
            prepare(
              "UPDATE session_nodes SET entry_valid = 1, rowid = ? WHERE session_key = ?",
            ).run(expectDefined(beforeRow?.rowid, "selected rowid"), selected.sessionKey);
            expect(readRow()).toEqual(beforeRow);
          }
          // Publish the recreated row's committed postimage through its write owner.
          writeSelected(
            current,
            write === "committed selected recreated sessionId"
              ? { sessionId: "replacement" }
              : write === "committed selected recreated lifecycle"
                ? { lifecycleRevision: "replacement" }
                : {},
          );
        }, selected);
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
    if (allowed) {
      expect(loadSessionEntry(selected)).toEqual(before);
      expect(error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(true, metadata);
      if (write.includes("sibling") && (write.endsWith("owner") || write.endsWith("participant"))) {
        const changed = expectDefined(loadSessionEntry(sibling), "changed sibling");
        if (write.endsWith("owner")) {
          expect(changed.owner?.actor.id).toBe("other");
        } else {
          expect(changed.participantCount).toBe(2);
        }
      }
    } else {
      expectSuperseded(
        error,
        write === "runtime config replacement" || write === "profile alias change",
      );
      expect(respond).not.toHaveBeenCalled();
    }
    await cleanupSessionStateForTest({ stateDir: state.stateDir });
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  }),
);

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
