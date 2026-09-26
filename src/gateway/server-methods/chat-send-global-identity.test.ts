import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { readSessionPendingInputByKey } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
} from "../../state/openclaw-agent-db.js";
import * as profileReader from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as sessionUtils from "../session-utils.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import type { GatewayClient } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

it.each<{
  name: string;
  raw: boolean;
  literal: boolean;
  shared: boolean;
  key: string;
  allowed: boolean;
  separateStore?: boolean;
  replaceDatabase?: "copy" | "symlink";
  replayAfterCollision?: boolean;
  writeDuringAdmission?: "counterpart" | "unrelated";
  writeDuringProfilePreparation?: boolean;
  replaceDuringPersistence?: boolean;
  pendingReplacement?: boolean;
  switchStoreAfterAck?: boolean;
}>([
  {
    name: "raw global only",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
  },
  {
    name: "colliding raw request",
    raw: true,
    literal: true,
    shared: false,
    key: "global",
    allowed: false,
  },
  {
    name: "colliding literal request",
    raw: true,
    literal: true,
    shared: false,
    key: "agent:research:global",
    allowed: false,
  },
  {
    name: "missing raw with literal present",
    raw: false,
    literal: true,
    shared: false,
    key: "global",
    allowed: false,
  },
  {
    name: "distinct owner in shared store",
    raw: true,
    literal: true,
    shared: true,
    key: "agent:research:global",
    allowed: true,
  },
  {
    name: "collision across discovered stores",
    raw: true,
    literal: true,
    shared: false,
    key: "global",
    allowed: false,
    separateStore: true,
  },
  {
    name: "missing raw with literal in another store",
    raw: false,
    literal: true,
    shared: false,
    key: "global",
    allowed: false,
    separateStore: true,
  },
  ...(["copy", "symlink"] as const).map((replaceDatabase) => ({
    name: `database ${replaceDatabase} after selection`,
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: false,
    replaceDatabase,
  })),
  {
    name: "cached retry after collision",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
    replayAfterCollision: true,
  },
  {
    name: "counterpart appears while operator profile preparation waits",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: false,
    writeDuringProfilePreparation: true,
  },
  {
    name: "counterpart appears while admission waits",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: false,
    writeDuringAdmission: "counterpart",
  },
  {
    name: "unrelated row appears while admission waits",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
    writeDuringAdmission: "unrelated",
  },
  {
    name: "database replacement after recorder target resolution",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
    replaceDuringPersistence: true,
  },
  {
    name: "pending custody survives replacement through cleanup",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
    replaceDuringPersistence: true,
    pendingReplacement: true,
  },
  {
    name: "config store changes after ACK",
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
    switchStoreAfterAck: true,
  },
])("binds chat.send to its stored global identity: $name", async (scenario) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.path(
      scenario.shared
        ? "shared.sqlite"
        : scenario.replaceDatabase === "symlink"
          ? "linked.sqlite"
          : "research.json",
    );
    const physicalAgentId = scenario.shared ? "ops" : "research";
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { research: {}, ops: {} },
        defaults: { sessionStore: { agentId: physicalAgentId } },
      },
      session: {
        scope: "global",
        store: scenario.separateStore ? state.path("{agentId}.json") : storePath,
      },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const storeScope = {
      agentId: physicalAgentId,
      ...(scenario.shared || scenario.replaceDatabase === "symlink"
        ? { defaultAgentId: physicalAgentId }
        : {}),
      storePath,
    };
    const literalScope = {
      agentId: "research",
      storePath: scenario.separateStore
        ? state.statePath("agents", "research", "sessions", "sessions.json")
        : storePath,
      sessionKey: "agent:research:global",
      sessionId: "literal-session",
    };
    const rows = [
      ...(scenario.raw ? [{ ...storeScope, sessionKey: "global", sessionId: "raw-session" }] : []),
      ...(scenario.literal ? [literalScope] : []),
    ];
    const seedRow = async (row: (typeof rows)[number]) => {
      await replaceSessionEntry(row, {
        sessionId: row.sessionId,
        lifecycleRevision: "original",
        updatedAt: 1,
        status: "done",
      });
      await appendTranscriptMessage(row, {
        message: { role: "assistant", content: `Retained ${row.sessionId} history`, timestamp: 1 },
      });
    };
    for (const row of rows) {
      await seedRow(row);
    }
    if (scenario.replaceDatabase) {
      await closeOpenClawAgentDatabasesAsync(state.root);
    }
    const originalPath = state.path("original.sqlite");
    const replacementPath = state.path("replacement.sqlite");
    if (scenario.replaceDatabase === "symlink") {
      fs.renameSync(storePath, originalPath);
      fs.copyFileSync(originalPath, replacementPath);
      fs.symlinkSync(originalPath, storePath);
    }
    const snapshot = async () => ({
      entries: rows.map((row) => loadExactSessionEntryReadOnly(row)?.entry),
      keys: [storeScope, ...(scenario.separateStore ? [literalScope] : [])].map((scope) =>
        listSessionEntriesCore(scope)
          .map((row) => row.sessionKey)
          .toSorted(),
      ),
      transcripts: await Promise.all(rows.map((row) => loadTranscriptEvents(row))),
    });
    let before = await snapshot();
    const runId = `global-identity-${scenario.name}`;
    const message =
      scenario.replaceDuringPersistence && !scenario.pendingReplacement
        ? "/status"
        : "Keep this input in the selected physical row.";
    const entered = createDeferred<DispatchOptions>();
    const release = createDeferred();
    const admissionOwned = createDeferred();
    const resumeAdmission = createDeferred();
    let sending: Promise<void> | undefined;
    const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
    const holdDispatch = vi
      .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
      .mockImplementation(async (options) => {
        entered.resolve(options);
        await release.promise;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
    const context = createDirectChatContext({ getRuntimeConfig });
    const profilePrepared = createDeferred();
    const resumeProfile = createDeferred();
    const admissionCallback = vi.fn(async () => true);
    const interrupted = vi.fn();
    const activeRun = scenario.writeDuringProfilePreparation
      ? createReplyOperation({
          agentId: "research",
          sessionKey: "agent:research:global",
          sessionId: "raw-session",
          resetTriggered: false,
        })
      : undefined;
    activeRun?.attachBackend({
      kind: "embedded",
      runId: "preparing-profile-predecessor",
      cancel: () => {
        interrupted();
        expectDefined(activeRun, "active predecessor run").complete();
      },
    });
    const profile = scenario.writeDuringProfilePreparation
      ? ensureProfileForEmail("chat-target-preparation@example.test")
      : undefined;
    const client: GatewayClient | null = profile
      ? {
          connId: "chat-target-preparation",
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: null,
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          },
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            role: "operator",
            scopes: ["operator.admin"],
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "web",
              mode: "webchat",
            },
          },
        }
      : null;
    let preparedProfile:
      | Awaited<ReturnType<typeof profileReader.prepareUserProfileIdentity>>
      | undefined;
    const prepareProfile = profileReader.prepareUserProfileIdentity;
    const holdProfile = profile
      ? vi
          .spyOn(profileReader, "prepareUserProfileIdentity")
          .mockImplementation(async (...args) => {
            const prepared = await prepareProfile(...args);
            preparedProfile = prepared;
            vi.spyOn(prepared, "release");
            profilePrepared.resolve();
            await resumeProfile.promise;
            return prepared;
          })
      : undefined;
    let databaseReplaced = false;
    const loadSessionEntry = sessionUtils.loadSessionEntry;
    const replaceAfterSelection = scenario.replaceDatabase
      ? vi.spyOn(sessionUtils, "loadSessionEntry").mockImplementation((...args) => {
          const loaded = loadSessionEntry(...args);
          if (!databaseReplaced) {
            const source = loaded.readSource;
            if (!source) {
              throw new Error("Expected the selected physical database before replacement");
            }
            closeOpenClawAgentDatabaseByPath(source.path);
            if (scenario.replaceDatabase === "copy") {
              fs.renameSync(source.path, originalPath);
              fs.copyFileSync(originalPath, source.path);
            } else {
              fs.unlinkSync(storePath);
              fs.symlinkSync(replacementPath, storePath);
            }
            databaseReplaced = true;
          }
          return loaded;
        })
      : undefined;
    try {
      const respond = vi.fn();
      const params = {
        agentId: "research",
        sessionKey: scenario.key,
        message,
        idempotencyKey: runId,
        ...(scenario.writeDuringProfilePreparation ? { queueMode: "interrupt" as const } : {}),
      };
      sending = handleDirectExternalChatSend(
        {
          params,
          req: { type: "req", id: runId, method: "chat.send", params },
          respond,
          context,
          client,
          isWebchatConnect: () => false,
        },
        scenario.writeDuringAdmission
          ? async () => {
              admissionOwned.resolve();
              await resumeAdmission.promise;
              return true;
            }
          : scenario.writeDuringProfilePreparation
            ? admissionCallback
            : undefined,
      );
      if (scenario.writeDuringProfilePreparation) {
        try {
          await Promise.race([
            profilePrepared.promise,
            sending.then(() => {
              throw new Error("chat.send settled before real operator profile preparation");
            }),
          ]);
          await seedRow(literalScope);
          rows.push(literalScope);
          const withCounterpart = await snapshot();
          expect(withCounterpart.entries[0]).toEqual(before.entries[0]);
          expect(withCounterpart.transcripts[0]).toEqual(before.transcripts[0]);
          before = withCounterpart;
        } finally {
          resumeProfile.resolve();
        }
      }
      if (scenario.writeDuringAdmission) {
        try {
          await Promise.race([
            admissionOwned.promise,
            sending.then(() => {
              throw new Error("chat.send settled before the admission callback");
            }),
          ]);
          const inserted =
            scenario.writeDuringAdmission === "counterpart"
              ? literalScope
              : {
                  ...literalScope,
                  sessionKey: "agent:research:other",
                  sessionId: "unrelated-session",
                };
          await seedRow(inserted);
          rows.push(inserted);
          const withCounterpart = await snapshot();
          expect(withCounterpart.entries[0]).toEqual(before.entries[0]);
          expect(withCounterpart.transcripts[0]).toEqual(before.transcripts[0]);
          before = withCounterpart;
        } finally {
          resumeAdmission.resolve();
        }
      }
      await sending;
      if (scenario.writeDuringProfilePreparation) {
        expect(interrupted).not.toHaveBeenCalled();
        expect(admissionCallback).not.toHaveBeenCalled();
        expect(
          expectDefined(preparedProfile, "prepared operator profile").release,
        ).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("ambiguous stored identity"),
          }),
        );
      }
      if (!scenario.allowed) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(observeDispatch).not.toHaveBeenCalled();
        expect(holdDispatch).not.toHaveBeenCalled();
        expect(context.addChatRun).not.toHaveBeenCalled();
        expect(context.chatAbortControllers.size).toBe(0);
        expect(context.chatQueuedTurns.size).toBe(0);
        expect(
          getSessionWorkAdmissionRelease({
            scope: storePath,
            identities: [scenario.key, "raw-session", "literal-session"],
          }),
        ).toBeUndefined();
        expect(await snapshot()).toEqual(before);
        if (scenario.replaceDatabase) {
          expect(databaseReplaced).toBe(true);
          const original = {
            ...expectDefined(rows[0], "original selected row"),
            defaultAgentId: physicalAgentId,
            storePath: originalPath,
          };
          expect(loadExactSessionEntryReadOnly(original)?.entry).toEqual(before.entries[0]);
          expect(await loadTranscriptEvents(original)).toEqual(before.transcripts[0]);
        }
        return;
      }
      expect(respond).toHaveBeenCalledWith(
        true,
        { runId, status: "started" },
        undefined,
        expect.anything(),
      );
      await entered.promise;
      const owned = observeDispatch.mock.calls.at(-1)?.[0];
      if (!owned) {
        throw new Error("chat.send did not dispatch the selected session");
      }
      const selected = expectDefined(
        rows.find((row) => row.sessionKey === scenario.key),
        "requested session row",
      );
      expect(owned.session).toMatchObject({
        agentId: "research",
        sessionKey: selected.sessionKey,
        activeRunScopeKey: "agent:research:global",
        entry: { sessionId: selected.sessionId },
        readSource: { agentId: physicalAgentId },
      });
      if (scenario.replaceDuringPersistence) {
        expect(owned.turn.isInternalTextSlashCommandTurn).toBe(!scenario.pendingReplacement);
        if (scenario.pendingReplacement) {
          expect(owned.userTurn.recorder.getPendingInputMessage?.()).toMatchObject({
            role: "user",
            idempotencyKey: `${runId}:user`,
          });
        } else {
          expect(owned.userTurn.recorder.getPendingInputMessage?.()).toBeUndefined();
        }
        const source = owned.session.readSource;
        if (!source) {
          throw new Error("Expected the admitted physical database before persistence");
        }
        const beforePersistence = await snapshot();
        const readPending = (databasePath: string) => {
          // The display reader repairs stale disposition; observe the stored row without repair.
          const read = withOpenClawAgentDatabaseReadOnly(
            (database) => readSessionPendingInputByKey(database, selected, `${runId}:user`),
            { agentId: physicalAgentId, path: databasePath },
          );
          return read.found ? read.value : undefined;
        };
        const pendingBefore = scenario.pendingReplacement ? readPending(source.path) : undefined;
        if (scenario.pendingReplacement) {
          expect(pendingBefore).toMatchObject({ state: "queued", consumed_event_id: null });
        }
        const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
        const replaceAtPersistence = vi
          .spyOn(sessionAccessor, "persistSessionTranscriptTurn")
          .mockImplementationOnce(async (...args) => {
            await closeOpenClawAgentDatabaseByPathAsync(source.path);
            fs.renameSync(source.path, originalPath);
            fs.copyFileSync(originalPath, source.path);
            return persistTurn(...args);
          });
        try {
          await expect(
            owned.userTurn.persist(
              scenario.pendingReplacement ? undefined : { contextFreeCommand: true },
            ),
          ).rejects.toThrow(/database|identity|changed/i);
          expect(replaceAtPersistence).toHaveBeenCalledOnce();
          if (scenario.pendingReplacement) {
            expect(readPending(source.path)).toEqual(pendingBefore);
            expect(readPending(originalPath)).toEqual(pendingBefore);
            const settled = getSessionWorkAdmissionRelease({
              scope: owned.session.storePath,
              identities: [owned.session.sessionKey, selected.sessionId],
            });
            expect(settled).toBeDefined();
            release.resolve();
            await settled;
            expect(context.chatAbortControllers.has(runId)).toBe(false);
            expect(readPending(source.path)).toEqual(pendingBefore);
            expect(readPending(originalPath)).toEqual(pendingBefore);
          }
          expect(await snapshot()).toEqual(beforePersistence);
          const original = {
            ...selected,
            defaultAgentId: physicalAgentId,
            storePath: originalPath,
          };
          expect(loadExactSessionEntryReadOnly(original)?.entry).toEqual(
            beforePersistence.entries[0],
          );
          expect(await loadTranscriptEvents(original)).toEqual(beforePersistence.transcripts[0]);
        } finally {
          replaceAtPersistence.mockRestore();
        }
        return;
      }
      const otherStore = {
        ...selected,
        defaultAgentId: physicalAgentId,
        storePath: replacementPath,
      };
      let otherBefore:
        | {
            entry: ReturnType<typeof loadExactSessionEntryReadOnly>;
            transcript: Awaited<ReturnType<typeof loadTranscriptEvents>>;
          }
        | undefined;
      if (scenario.switchStoreAfterAck) {
        await seedRow(otherStore);
        otherBefore = {
          entry: loadExactSessionEntryReadOnly(otherStore),
          transcript: await loadTranscriptEvents(otherStore),
        };
        expect(otherBefore.entry?.entry).toMatchObject({
          sessionId: selected.sessionId,
          lifecycleRevision: owned.session.entry?.lifecycleRevision,
        });
        const changedConfig = { ...cfg, session: { ...cfg.session, store: replacementPath } };
        setRuntimeConfigSnapshot(changedConfig, changedConfig);
      }
      await owned.userTurn.persist();
      expect(await loadTranscriptEvents(selected)).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ role: "user", idempotencyKey: `${runId}:user` }),
        }),
      );
      expect(loadExactSessionEntryReadOnly(selected)?.entry.sessionId).toBe(selected.sessionId);
      if (otherBefore) {
        expect(loadExactSessionEntryReadOnly(otherStore)).toEqual(otherBefore.entry);
        expect(await loadTranscriptEvents(otherStore)).toEqual(otherBefore.transcript);
      }
      expect(
        listSessionEntriesCore(storeScope)
          .map((row) => row.sessionKey)
          .toSorted(),
      ).toEqual(rows.map((row) => row.sessionKey).toSorted());
      for (const [index, row] of rows.entries()) {
        if (row !== selected) {
          expect(loadExactSessionEntryReadOnly(row)?.entry).toEqual(before.entries[index]);
          expect(await loadTranscriptEvents(row)).toEqual(before.transcripts[index]);
        }
      }
      if (scenario.replayAfterCollision) {
        const settled = getSessionWorkAdmissionRelease({
          scope: owned.session.storePath,
          identities: [owned.session.sessionKey, selected.sessionId],
        });
        release.resolve();
        await settled;
        const cached = context.dedupe.get(`chat:${runId}`);
        expect(cached).toMatchObject({ ok: true, payload: { runId, status: "ok" } });
        await seedRow(literalScope);
        rows.push(literalScope);
        const beforeRetry = await snapshot();
        const replayResponse = vi.fn();
        await handleDirectExternalChatSend({
          params,
          req: { type: "req", id: `${runId}-retry`, method: "chat.send", params },
          respond: replayResponse,
          context,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(replayResponse).toHaveBeenCalledExactlyOnceWith(true, cached?.payload, undefined, {
          cached: true,
        });
        expect(observeDispatch).toHaveBeenCalledOnce();
        expect(holdDispatch).toHaveBeenCalledOnce();
        expect(await snapshot()).toEqual(beforeRetry);
      }
    } finally {
      resumeProfile.resolve();
      resumeAdmission.resolve();
      await Promise.allSettled(sending ? [sending] : []);
      const owned = observeDispatch.mock.calls.at(-1)?.[0];
      const settled = owned
        ? getSessionWorkAdmissionRelease({
            scope: owned.session.storePath,
            identities: [owned.session.sessionKey, owned.session.entry?.sessionId],
          })
        : undefined;
      release.resolve();
      await settled;
      activeRun?.complete();
      if (preparedProfile) {
        vi.mocked(preparedProfile.release).mockRestore();
      }
      holdProfile?.mockRestore();
      replaceAfterSelection?.mockRestore();
      holdDispatch.mockRestore();
      observeDispatch.mockRestore();
    }
  });
});
