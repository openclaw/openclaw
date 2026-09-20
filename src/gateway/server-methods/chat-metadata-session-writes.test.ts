import { DatabaseSync } from "node:sqlite";
import { expectDefined, safeParseJsonRecord } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptEventSync,
  assignSessionOwner,
  listSessionEntriesCore,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  patchSessionEntryCore,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const cases = [
  { write: "tracked sibling update", allowed: true },
  { write: "raw sibling update", allowed: true },
  { write: "sibling transcript append", allowed: true },
  { write: "sibling cache replacement", allowed: true },
  { write: "canonical sibling owner", allowed: true },
  { write: "canonical sibling participant", allowed: true },
  { write: "legacy sibling owner", allowed: true },
  { write: "legacy sibling participant", allowed: true },
  { write: "compound sibling owner", allowed: true },
  { write: "compound sibling participant", allowed: true },
  { write: "compound new sibling owner", allowed: true },
  { write: "compound new sibling participant", allowed: true },
  { write: "selected owner", allowed: false },
  { write: "selected participant", allowed: false },
  { write: "selected participant repeat", allowed: true },
  { write: "nested selected participant repeats", allowed: true },
  { write: "earlier selected participant first prompt", allowed: false },
  { write: "selected participant insert then repeat", allowed: false },
  { write: "selected participant repeat then insert", allowed: false },
  { write: "selected entry write then participant repeat", allowed: false },
  { write: "selected participant repeat then entry write", allowed: false },
  { write: "rolled-back selected owner", allowed: true },
  { write: "rolled-back selected participant", allowed: true },
  { write: "raw before sibling owner", allowed: false },
  { write: "raw after sibling owner", allowed: false },
  { write: "raw before sibling participant", allowed: false },
  { write: "raw after sibling participant", allowed: false },
  { write: "tracked selected update", allowed: false },
  { write: "selected lifecycle change", allowed: false },
  { write: "external sibling update", allowed: true },
  // Identical target facts remain publishable even if the row was recreated.
  { write: "external selected identical recreation", allowed: true },
  { write: "external selected fully restored recreation", allowed: true },
  { write: "external selected recreated sessionId", allowed: false },
  { write: "external selected recreated payload", allowed: false },
  { write: "external selected recreated lifecycle", allowed: false },
  { write: "runtime config replacement", allowed: false },
  { write: "access revision change", allowed: false },
] as const;

it.each(
  cases.flatMap(({ write, allowed }) =>
    ["exact", "full"].map((cache) => ({ write, allowed, cache })),
  ),
)("metadata read across $write with $cache cache", async ({ write, allowed, cache }) => {
  await withOpenClawTestState({ label: "metadata-cache-boundary" }, async (state) => {
    const config = {};
    let runtimeConfig = config;
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const selected = { agentId: "main", sessionKey: "agent:main:metadata-selected" };
    const sibling = { agentId: "main", sessionKey: "agent:main:metadata-sibling" };
    const writeTarget = write.includes("new sibling")
      ? { ...sibling, sessionKey: "agent:main:new-sibling" }
      : sibling;
    await upsertSessionEntryCore(selected, {
      sessionId: "selected",
      lifecycleRevision: "selected-original",
      sessionStartedAt: 1,
      label: "selected",
      updatedAt: 1,
    });
    await upsertSessionEntryCore(sibling, {
      sessionId: "sibling",
      label: "sibling",
      updatedAt: 1,
    });
    // Prepare optional schema before capture so the probe measures a row mutation only.
    assignSessionOwner(sibling, {
      owner: { type: "agent", id: "main" },
      assignedBy: { type: "agent", id: "main" },
      assignedAt: 1,
    });
    recordSessionParticipant(sibling, {
      identity: { type: "agent", id: "seed-participant" },
      promptedAt: 1,
    });
    const selectedParticipantChange =
      write.includes("repeat") || write === "earlier selected participant first prompt";
    const recordSelected = (id: string, promptedAt: number) =>
      recordSessionParticipant(selected, { identity: { type: "agent", id }, promptedAt });
    if (selectedParticipantChange) {
      recordSelected("a", 10);
      recordSelected("b", 20);
    }
    const database = openOpenClawAgentDatabase(selected);
    if (write.startsWith("legacy sibling")) {
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.owner', json(?), '$.participants', json(?), '$.participantCount', 1) WHERE session_key = ?",
        )
        .run(
          JSON.stringify({ actor: { type: "human", id: "json-only-owner" } }),
          JSON.stringify([{ identity: { type: "agent", id: "json-only-participant" } }]),
          sibling.sessionKey,
        );
      if (write.endsWith("owner")) {
        database.db
          .prepare("DELETE FROM session_participants WHERE session_key = ?")
          .run(sibling.sessionKey);
        expect(loadSessionEntry(sibling)).not.toHaveProperty("participants");
      } else {
        database.db
          .prepare(
            "UPDATE session_nodes SET owner_actor_type = NULL, owner_actor_id = NULL, owner_assigned_by_type = NULL, owner_assigned_by_id = NULL, owner_assigned_at = NULL WHERE session_key = ?",
          )
          .run(sibling.sessionKey);
        expect(loadSessionEntry(sibling)).not.toHaveProperty("owner");
      }
    }
    const before = expectDefined(loadSessionEntry(selected), "selected session entry");
    if (cache === "full") {
      listSessionEntriesCore({ ...selected, projection: "list" });
    }
    const metadata = { commands: [], models: [], swarmEnabled: false };
    const sideWrite = (target: typeof selected) => {
      if (write.includes("participant")) {
        expect(
          recordSessionParticipant(target, {
            identity: { type: "agent", id: "second-participant" },
            promptedAt: 2,
          }),
        ).toBe("inserted");
      } else {
        expect(
          assignSessionOwner(target, {
            owner: { type: "agent", id: "other" },
            assignedBy: { type: "agent", id: "main" },
            assignedAt: 2,
          }),
        ).not.toBeNull();
      }
    };
    const rawSelectedWrite = () =>
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'raw') WHERE session_key = ?",
        )
        .run(selected.sessionKey);
    const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async (scope) => {
      expect(scope.isCurrent?.()).toBe(true);
      if (write === "tracked sibling update") {
        await upsertSessionEntryCore(sibling, { label: "changed sibling" });
      } else if (write === "raw sibling update" || write === "sibling cache replacement") {
        database.db
          .prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
          .run(sibling.sessionKey);
        if (write === "sibling cache replacement") {
          listSessionEntriesCore({ ...sibling, projection: "list" });
        }
      } else if (write === "sibling transcript append") {
        expect(
          appendTranscriptEventSync(
            { ...sibling, sessionId: "sibling" },
            { type: "session", id: "sibling" },
          ),
        ).toEqual({ ok: true, value: true });
      } else if (write === "runtime config replacement") {
        runtimeConfig = {};
      } else if (write === "access revision change") {
        bumpGatewayAccessRevision();
      } else if (write.startsWith("compound")) {
        runOpenClawAgentWriteTransaction((current) => {
          writeSessionEntry(current, writeTarget.sessionKey, {
            sessionId: write.includes("new sibling") ? "new-sibling" : "sibling",
            updatedAt: 2,
            label: "compound update",
          });
          sideWrite(writeTarget);
        }, writeTarget);
      } else if (write.startsWith("canonical sibling") || write.startsWith("legacy sibling")) {
        sideWrite(sibling);
      } else if (write === "selected owner" || write === "selected participant") {
        sideWrite(selected);
      } else if (selectedParticipantChange) {
        switch (write) {
          case "selected participant repeat":
            expect(recordSelected("a", 30)).toBe("updated");
            break;
          case "nested selected participant repeats":
            runOpenClawAgentWriteTransaction(() => {
              recordSelected("a", 30);
              runOpenClawAgentWriteTransaction(() => {
                recordSelected("a", 40);
                recordSelected("a", 50);
              }, selected);
            }, selected);
            break;
          case "earlier selected participant first prompt":
            recordSelected("b", 5);
            break;
          case "selected participant insert then repeat":
            runOpenClawAgentWriteTransaction(() => {
              recordSelected("c", 15);
              recordSelected("a", 30);
            }, selected);
            break;
          case "selected participant repeat then insert":
            runOpenClawAgentWriteTransaction(() => {
              recordSelected("a", 30);
              recordSelected("c", 15);
            }, selected);
            break;
          case "selected entry write then participant repeat":
            runOpenClawAgentWriteTransaction((current) => {
              writeSessionEntry(current, selected.sessionKey, {
                ...before,
                label: "changed selected",
                updatedAt: 2,
              });
              recordSelected("a", 30);
            }, selected);
            break;
          case "selected participant repeat then entry write":
            runOpenClawAgentWriteTransaction((current) => {
              recordSelected("a", 30);
              writeSessionEntry(current, selected.sessionKey, {
                ...before,
                label: "changed selected",
                updatedAt: 2,
              });
            }, selected);
            break;
          default:
            throw new Error(`Unhandled selected participant change: ${write}`);
        }
      } else if (write.startsWith("rolled-back")) {
        const rollback = new Error("roll back side metadata");
        expect(() =>
          runOpenClawAgentWriteTransaction(() => {
            sideWrite(selected);
            expect(scope.isCurrent?.()).toBe(true);
            throw rollback;
          }, selected),
        ).toThrow(rollback);
      } else if (write.startsWith("raw ")) {
        runOpenClawAgentWriteTransaction(() => {
          if (write.startsWith("raw before")) {
            rawSelectedWrite();
          }
          sideWrite(sibling);
          if (write.startsWith("raw after")) {
            rawSelectedWrite();
          }
        }, selected);
      } else if (write === "tracked selected update") {
        await upsertSessionEntryCore(selected, { label: "changed selected" });
      } else if (write === "selected lifecycle change") {
        await upsertSessionEntryCore(selected, { lifecycleRevision: "selected-replaced" });
      } else {
        const external = new DatabaseSync(database.path);
        try {
          if (write === "external sibling update") {
            external
              .prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
              .run(sibling.sessionKey);
          } else {
            const beforeRow = external
              .prepare("SELECT rowid, * FROM session_nodes WHERE session_key = ?")
              .get(selected.sessionKey);
            external.exec("CREATE TEMP TABLE saved_node AS SELECT * FROM session_nodes;");
            external
              .prepare("DELETE FROM session_nodes WHERE session_key = ?")
              .run(selected.sessionKey);
            external
              .prepare("INSERT INTO session_nodes SELECT * FROM saved_node WHERE session_key = ?")
              .run(selected.sessionKey);
            if (write === "external selected fully restored recreation") {
              external
                .prepare(
                  "UPDATE session_nodes SET entry_valid = 1, rowid = ? WHERE session_key = ?",
                )
                .run(expectDefined(beforeRow?.rowid, "selected rowid"), selected.sessionKey);
              expect(
                external
                  .prepare("SELECT rowid, * FROM session_nodes WHERE session_key = ?")
                  .get(selected.sessionKey),
              ).toEqual(beforeRow);
            } else if (write === "external selected recreated sessionId") {
              external
                .prepare(
                  "UPDATE session_nodes SET current_session_id = 'replacement', entry_json = json_set(entry_json, '$.sessionId', 'replacement') WHERE session_key = ?",
                )
                .run(selected.sessionKey);
            } else if (write === "external selected recreated payload") {
              rawSelectedWrite();
            } else if (write === "external selected recreated lifecycle") {
              external
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', 'replacement') WHERE session_key = ?",
                )
                .run(selected.sessionKey);
            }
          }
        } finally {
          external.close();
        }
      }
      if (allowed) {
        expect(scope.assertCurrent).toBeDefined();
        scope.assertCurrent!();
      }
      return metadata;
    });
    const respond = vi.fn<RespondFn>();
    const handler = chatHistoryHandlers["chat.metadata"]!;
    const outcome = await Promise.resolve()
      .then(() =>
        handler({
          params: { sessionKey: selected.sessionKey },
          context: createDirectChatContext({
            getRuntimeConfig: () => runtimeConfig,
            readChatMetadata,
          }),
          respond,
          client: null,
          req: { type: "req", id: "metadata-cache-boundary", method: "chat.metadata" },
          isWebchatConnect: () => false,
        }),
      )
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
    const after = loadSessionEntry(selected);
    expect(readChatMetadata).toHaveBeenCalledTimes(1);
    if (allowed) {
      expect(after).toEqual(before);
      expect(outcome.error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(true, metadata);
      if (write === "canonical sibling owner") {
        expect(loadSessionEntry(sibling)?.owner?.actor.id).toBe("other");
      } else if (write === "canonical sibling participant") {
        expect(loadSessionEntry(sibling)?.participantCount).toBe(2);
      } else if (write.startsWith("legacy sibling")) {
        const published = listSessionEntriesCore({ ...sibling, projection: "list" }).find(
          (row) => row.sessionKey === sibling.sessionKey,
        )?.entry;
        if (write.endsWith("owner")) {
          expect(published?.owner?.actor.id).toBe("other");
          expect(published).not.toHaveProperty("participants");
          expect(published).not.toHaveProperty("participantCount");
        } else {
          expect(published?.participantCount).toBe(2);
          expect(published).not.toHaveProperty("owner");
        }
        expect(
          database.db
            .prepare(
              "SELECT json_extract(entry_json, '$.owner.actor.id') AS legacy_owner, json_array_length(entry_json, '$.participants') AS legacy_participants FROM session_nodes WHERE session_key = ?",
            )
            .get(sibling.sessionKey),
        ).toEqual({
          legacy_owner: "json-only-owner",
          legacy_participants: 1,
        });
      } else if (write.startsWith("compound")) {
        const published = listSessionEntriesCore({ ...sibling, projection: "list" }).find(
          (row) => row.sessionKey === writeTarget.sessionKey,
        )?.entry;
        expect(published).toMatchObject({ label: "compound update", updatedAt: 2 });
        if (write.endsWith("owner")) {
          expect(published?.owner?.actor.id).toBe("other");
        } else {
          expect(published?.participantCount).toBe(write.includes("new sibling") ? 1 : 2);
        }
      }
    } else {
      expect(outcome.error).toMatchObject({
        message: expect.stringContaining("Session changed while preparing its metadata"),
      });
      expect(respond).not.toHaveBeenCalled();
    }
    if (selectedParticipantChange) {
      const participantIds =
        write === "earlier selected participant first prompt"
          ? ["b", "a"]
          : write.includes("insert")
            ? ["a", "c", "b"]
            : ["a", "b"];
      const expected = {
        label: write.includes("entry write") ? "changed selected" : "selected",
        updatedAt: write.includes("entry write") ? 2 : before.updatedAt,
        participants: participantIds.map((id) => ({ identity: { type: "agent", id } })),
        participantCount: participantIds.length,
      };
      expect(after).toMatchObject(expected);
      const published = listSessionEntriesCore({ ...selected, projection: "list" }).find(
        (row) => row.sessionKey === selected.sessionKey,
      )?.entry;
      expect(published).toMatchObject(expected);
      if (write !== "earlier selected participant first prompt") {
        expect(listSessionParticipantsReadOnly(selected).get(selected.sessionKey)).toContainEqual({
          identity: { type: "agent", id: "a" },
          contributionCount: write === "nested selected participant repeats" ? 4 : 2,
          firstPromptedAt: 10,
          lastPromptedAt: write === "nested selected participant repeats" ? 50 : 30,
        });
      }
    }
    await cleanupSessionStateForTest({ stateDir: state.stateDir });
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  });
});

it("keeps prepared chat metadata across only a committed read acknowledgment", async () => {
  await withOpenClawTestState(
    { label: "metadata-read-acknowledgment", env: WITHOUT_OPENAI_ENV_AUTH },
    async (state) => {
      const config = createOpenAIChatMetadataConfig();
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const selected = { agentId: "main", sessionKey: "agent:main:metadata-read-marker" };
      await upsertSessionEntryCore(selected, {
        sessionId: "read-marker-session",
        lifecycleRevision: "read-marker-lifecycle",
        sessionStartedAt: 1,
        updatedAt: 1,
        lastReadAt: 1,
        label: "read-marker-label",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        authProfileOverride: "openai:read-marker",
        authProfileOverrideSource: "user",
        toolOverrides: { webSearch: false },
      });
      const before = expectDefined(loadSessionEntry(selected), "selected entry");
      const database = openOpenClawAgentDatabase(selected);
      const readRow = () =>
        expectDefined(
          database.db
            .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
            .get(selected.sessionKey),
          "selected row",
        );
      const beforeRow = readRow();
      const beforePayload = expectDefined(
        safeParseJsonRecord(String(beforeRow.entry_json)),
        "selected payload",
      );
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      harness.setOwner(
        createChatMetadataOwner(config, "gpt-5.6-luna", {}, "openai", "openai-chatgpt-responses"),
      );
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        readChatMetadata: harness.runtime.read,
      });
      const handler = expectDefined(chatHistoryHandlers["chat.metadata"], "metadata handler");
      const invoke = (respond: RespondFn) =>
        Promise.resolve(
          handler({
            params: { sessionKey: selected.sessionKey },
            context,
            respond,
            client: null,
            req: { type: "req", id: "metadata-read-marker", method: "chat.metadata" },
            isWebchatConnect: () => false,
          }),
        );
      let release: (() => void) | undefined;
      let pending: Promise<void> | undefined;
      const heldRead = async (changeReadMarker: boolean) => {
        const entered = createDeferred();
        const gate = createDeferred();
        release = () => gate.resolve();
        harness.buildCommands.mockImplementationOnce(async () => {
          entered.resolve();
          await gate.promise;
          return { commands: [{ name: "help" }] };
        });
        const respond = vi.fn<RespondFn>();
        const request = invoke(respond);
        pending = request;
        void request.catch(() => {});
        await Promise.race([
          entered.promise,
          request.then(() => {
            throw new Error("Metadata completed before the preparation hold");
          }),
        ]);
        try {
          if (changeReadMarker) {
            await patchSessionEntryCore(selected, () => ({ lastReadAt: 2 }), {
              preserveActivity: true,
            });
          }
          expect(loadSessionEntry(selected)).toEqual(
            changeReadMarker ? { ...before, lastReadAt: 2 } : before,
          );
          expect(readRow()).toEqual(
            changeReadMarker
              ? {
                  ...beforeRow,
                  entry_json: JSON.stringify({ ...beforePayload, lastReadAt: 2 }),
                  last_read_at: 2,
                }
              : beforeRow,
          );
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
            commands: [{ name: "help" }],
            models: [expect.objectContaining({ id: "gpt-5.6-luna", provider: "openai" })],
          }),
        );
        harness.runtime.invalidate();
        await harness.runtime.refresh();
        const changed = await heldRead(true);
        const fresh = vi.fn<RespondFn>();
        await invoke(fresh);
        // Fresh preparation agrees before asserting the held request, including on the old source.
        expect(fresh.mock.calls).toEqual(control.respond.mock.calls);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        expect(changed.error).toBeUndefined();
        expect(changed.respond.mock.calls).toEqual(control.respond.mock.calls);
      } finally {
        release?.();
        await pending?.catch(() => {});
        await harness.runtime.stop();
      }
    },
  );
});
