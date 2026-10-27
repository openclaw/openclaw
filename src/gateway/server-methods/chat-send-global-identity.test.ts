import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
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
import { SessionPendingInputCustodyError } from "../../config/sessions/session-pending-input-custody-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { captureSessionControllerSettlement } from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as sessionStores from "../session-utils-store.js";
import { holdProjectedChatDispatch } from "./chat-send-authority.test-support.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";

const configChanges = [
  ["unrelated", true, () => ({ logging: { level: "debug" }, ui: { seamColor: "#123456" } })],
  [
    "unrelated provider",
    true,
    () => ({
      models: {
        providers: {
          other: {
            baseUrl: "https://provider.example.test/v1",
            api: "openai-responses",
            models: [],
          },
        },
      },
    }),
  ],
  ["unrelated channel", true, () => ({ channels: { telegram: { enabled: false } } })],
  [
    "model",
    false,
    (cfg) => ({
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: "anthropic/claude-sonnet-4-6",
        },
      },
    }),
  ],
  ["security", false, () => ({ tools: { fs: { workspaceOnly: true } } })],
  ["routing", false, (cfg) => ({ session: { ...cfg.session, mainKey: "changed-main" } })],
] satisfies Array<[string, boolean, (cfg: OpenClawConfig) => OpenClawConfig]>;

type IdentityScenario = {
  name: string;
  raw: boolean;
  literal: boolean;
  shared: boolean;
  key: string;
  allowed: boolean;
  separateStore?: boolean;
  replaceDatabase?: "copy" | "symlink";
  replayAfterCollision?: boolean;
  writeDuringAdmission?: boolean;
  replaceDuringPersistence?: boolean;
  pendingReplacement?: boolean;
  switchStoreAfterAck?: boolean;
  configDuringAdmission?: (cfg: OpenClawConfig) => OpenClawConfig;
};
function identityScenario(
  name: string,
  overrides: Partial<IdentityScenario> = {},
): IdentityScenario {
  return {
    name,
    raw: true,
    literal: false,
    shared: false,
    key: "global",
    allowed: true,
    ...overrides,
  };
}

it.each<IdentityScenario>([
  ...Object.entries<Partial<IdentityScenario>>({
    "raw global only": {},
    "colliding raw request": { literal: true, allowed: false },
    "colliding literal request": { literal: true, key: "agent:research:global", allowed: false },
    "missing raw with literal present": { raw: false, literal: true, allowed: false },
    "distinct owner in shared store": { literal: true, shared: true, key: "agent:research:global" },
    "empty counterpart store preserves raw source": { separateStore: true },
    "collision across discovered stores": { literal: true, allowed: false, separateStore: true },
    "missing raw with literal in another store": {
      raw: false,
      literal: true,
      allowed: false,
      separateStore: true,
    },
    "cached retry after collision": { replayAfterCollision: true },
    "unrelated row appears while admission waits": { writeDuringAdmission: true },
    "database replacement after recorder target resolution": { replaceDuringPersistence: true },
    "pending custody survives replacement through cleanup": {
      replaceDuringPersistence: true,
      pendingReplacement: true,
    },
    "config store changes after ACK": { switchStoreAfterAck: true },
  }).map(([name, overrides]) => identityScenario(name, overrides)),
  ...(["copy", "symlink"] as const).map((replaceDatabase) =>
    identityScenario(`database ${replaceDatabase} after selection`, {
      allowed: false,
      replaceDatabase,
    }),
  ),
  ...configChanges.map(([name, allowed, configDuringAdmission]) =>
    identityScenario(`${name} config changes during admission read`, {
      allowed,
      configDuringAdmission,
    }),
  ),
])("binds chat.send to its stored global identity: $name", async (scenario) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await loadOrCreateProcessDeviceIdentityAsync();
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
        // Identity assertions require live rows, not fixtures eligible for age-retention archiving.
        updatedAt: Date.now(),
        status: "done",
      });
      await appendTranscriptMessage(row, {
        message: { role: "assistant", content: `Retained ${row.sessionId} history`, timestamp: 1 },
      });
    };
    for (const row of rows) {
      await seedRow(row);
    }
    if (scenario.separateStore && !scenario.literal) {
      await replaceSessionEntry(
        { ...literalScope, sessionKey: "agent:research:other" },
        { sessionId: "other-session", updatedAt: 1 },
      );
    }
    const originalPath = state.path("original.sqlite");
    const replacementPath = state.path("replacement.sqlite");
    const originalRow = (row: (typeof rows)[number]) => ({
      ...row,
      defaultAgentId: physicalAgentId,
      storePath: originalPath,
    });
    const sessionKeys = (scope: typeof storeScope) =>
      listSessionEntriesCore(scope)
        .map((row) => row.sessionKey)
        .toSorted();
    const copyDatabase = async (path: string, copyPath = path) => {
      await closeOpenClawAgentDatabaseByPathAsync(path);
      fs.renameSync(path, originalPath);
      fs.copyFileSync(originalPath, copyPath);
    };
    if (scenario.replaceDatabase === "symlink") {
      await copyDatabase(storePath, replacementPath);
      fs.symlinkSync(originalPath, storePath);
    }
    const snapshotRow = async (row: (typeof rows)[number]) => ({
      entry: loadExactSessionEntryReadOnly(row)?.entry,
      transcript: await loadTranscriptEvents(row),
    });
    const snapshot = async () => ({
      rows: await Promise.all(rows.map(snapshotRow)),
      keys: [storeScope, ...(scenario.separateStore ? [literalScope] : [])].map(sessionKeys),
    });
    let before = await snapshot();
    if (scenario.replaceDatabase) {
      // The synchronous selection hook replaces files after fixture readers have drained.
      await closeOpenClawAgentDatabasesAsync(state.root);
    }
    const runId = `global-identity-${scenario.name}`;
    const message =
      scenario.replaceDuringPersistence && !scenario.pendingReplacement
        ? "/status"
        : "Keep this input in the selected physical row.";
    const {
      entered,
      release,
      observe: observeDispatch,
      hold: holdDispatch,
    } = holdProjectedChatDispatch();
    const admissionOwned = createDeferred();
    const resumeAdmission = createDeferred();
    let sending: Promise<void> | undefined;
    const context = createDirectChatContext({ getRuntimeConfig });
    let configReloaded = false;
    const readQualifiedEntry = sessionStores.withQualifiedGatewaySessionEntry;
    const configChange = scenario.configDuringAdmission;
    const reloadDuringRead = configChange
      ? vi.spyOn(sessionStores, "withQualifiedGatewaySessionEntry").mockImplementation((params) =>
          readQualifiedEntry({
            ...params,
            consume: (...args) => {
              if (!configReloaded) {
                const changedConfig = { ...cfg, ...configChange(cfg) };
                setRuntimeConfigSnapshot(changedConfig, changedConfig);
                configReloaded = true;
              }
              return params.consume(...args);
            },
          }),
        )
      : undefined;
    let databaseReplaced = false;
    const readSessionEntry = sessionStores.withGatewaySessionEntry;
    const replaceAfterSelection = scenario.replaceDatabase
      ? vi.spyOn(sessionStores, "withGatewaySessionEntry").mockImplementation(async (...args) => {
          const loaded = await readSessionEntry(...args);
          if (!databaseReplaced) {
            const source = isRecord(loaded) ? loaded.capturedReadSource : undefined;
            if (!isRecord(source) || typeof source.path !== "string") {
              throw new Error("Expected the selected physical database before replacement");
            }
            if (scenario.replaceDatabase === "copy") {
              await copyDatabase(source.path);
            } else {
              await closeOpenClawAgentDatabaseByPathAsync(source.path);
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
      };
      const send = (response: typeof respond, id = runId, admit?: () => Promise<boolean>) =>
        handleDirectExternalChatSend(
          {
            params,
            req: { type: "req", id, method: "chat.send", params },
            respond: response,
            context,
            client: null,
            isWebchatConnect: () => false,
          },
          admit,
        );
      sending = send(
        respond,
        runId,
        scenario.writeDuringAdmission
          ? async () => {
              admissionOwned.resolve();
              await resumeAdmission.promise;
              return true;
            }
          : undefined,
      );
      if (scenario.writeDuringAdmission) {
        try {
          await awaitGateBeforeSettlement(
            admissionOwned.promise,
            sending,
            "chat.send settled before the admission callback",
          );
          const inserted = {
            ...literalScope,
            sessionKey: "agent:research:other",
            sessionId: "unrelated-session",
          };
          await seedRow(inserted);
          rows.push(inserted);
          const withCounterpart = await snapshot();
          expect(withCounterpart.rows[0]).toEqual(before.rows[0]);
          before = withCounterpart;
        } finally {
          resumeAdmission.resolve();
        }
      }
      await sending;
      if (scenario.configDuringAdmission) {
        expect(configReloaded).toBe(true);
      }
      if (!scenario.allowed) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(observeDispatch).not.toHaveBeenCalled();
        expect(context.addChatRun).not.toHaveBeenCalled();
        expect(rpcSourceTesting.size).toBe(0);
        expect(
          captureSessionControllerSettlement({
            scope: storePath,
            identities: [scenario.key, "raw-session", "literal-session"],
          }),
        ).toBeUndefined();
        expect(await snapshot()).toEqual(before);
        if (scenario.replaceDatabase) {
          expect(databaseReplaced).toBe(true);
          const original = originalRow(expectDefined(rows[0], "original selected row"));
          expect(await snapshotRow(original)).toEqual(before.rows[0]);
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
      const { session, userTurn } = owned;
      const selected = expectDefined(
        rows.find((row) => row.sessionKey === scenario.key),
        "requested session row",
      );
      const admissionReleased = () =>
        captureSessionControllerSettlement({
          scope: session.storePath,
          identities: [session.sessionKey, selected.sessionId],
        });
      expect(session).toMatchObject({
        agentId: "research",
        activeRunScopeKey: "agent:research:global",
      });
      if (scenario.replaceDuringPersistence) {
        const source = session.readSource;
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
        const pendingBefore = readPending(source.path);
        expect(pendingBefore).toEqual(
          scenario.pendingReplacement
            ? expect.objectContaining({ state: "queued", consumed_event_id: null })
            : undefined,
        );
        const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
        using replaceAtPersistence = vi
          .spyOn(sessionAccessor, "persistSessionTranscriptTurn")
          .mockImplementationOnce(async (...args) => {
            await copyDatabase(source.path);
            return persistTurn(...args);
          });
        await expect(
          userTurn.persist(scenario.pendingReplacement ? undefined : { contextFreeCommand: true }),
        ).rejects.toThrow(
          scenario.pendingReplacement
            ? SessionPendingInputCustodyError
            : /database|identity|changed/i,
        );
        expect(replaceAtPersistence).toHaveBeenCalledOnce();
        if (scenario.pendingReplacement) {
          expect(readPending(source.path)).toEqual(pendingBefore);
          expect(readPending(originalPath)).toEqual(pendingBefore);
          const settled = admissionReleased();
          expect(settled).toBeDefined();
          release.resolve();
          await settled;
          expect(rpcSourceTesting.has(runId)).toBe(false);
          expect(readPending(source.path)).toEqual(pendingBefore);
          expect(readPending(originalPath)).toEqual(pendingBefore);
        }
        expect(await snapshot()).toEqual(beforePersistence);
        expect(await snapshotRow(originalRow(selected))).toEqual(beforePersistence.rows[0]);

        return;
      }
      const otherStore = {
        ...selected,
        defaultAgentId: physicalAgentId,
        storePath: replacementPath,
      };
      if (scenario.switchStoreAfterAck) {
        await seedRow(otherStore);
      }
      const otherBefore = scenario.switchStoreAfterAck ? await snapshotRow(otherStore) : undefined;
      if (otherBefore) {
        expect(otherBefore.entry).toMatchObject({
          sessionId: selected.sessionId,
          lifecycleRevision: session.entry?.lifecycleRevision,
        });
        const changedConfig = { ...cfg, session: { ...cfg.session, store: replacementPath } };
        setRuntimeConfigSnapshot(changedConfig, changedConfig);
      }
      await userTurn.persist();
      expect(await loadTranscriptEvents(selected)).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ role: "user", idempotencyKey: `${runId}:user` }),
        }),
      );
      expect(loadExactSessionEntryReadOnly(selected)?.entry.sessionId).toBe(selected.sessionId);
      if (otherBefore) {
        expect(await snapshotRow(otherStore)).toEqual(otherBefore);
      }
      expect(sessionKeys(storeScope)).toEqual(rows.map((row) => row.sessionKey).toSorted());
      for (const [index, row] of rows.entries()) {
        if (row !== selected) {
          expect(await snapshotRow(row)).toEqual(before.rows[index]);
        }
      }
      if (scenario.replayAfterCollision) {
        const settled = admissionReleased();
        release.resolve();
        await settled;
        const cached = context.dedupe.get(`chat:${runId}`);
        expect(cached).toMatchObject({ ok: true, payload: { runId, status: "ok" } });
        await seedRow(literalScope);
        rows.push(literalScope);
        const beforeRetry = await snapshot();
        const replayResponse = vi.fn();
        await send(replayResponse, `${runId}-retry`);
        expect(replayResponse).toHaveBeenCalledExactlyOnceWith(true, cached?.payload, undefined, {
          cached: true,
        });
        expect(observeDispatch).toHaveBeenCalledOnce();
        expect(await snapshot()).toEqual(beforeRetry);
      }
    } finally {
      resumeAdmission.resolve();
      await Promise.allSettled(sending ? [sending] : []);
      const owned = observeDispatch.mock.calls.at(-1)?.[0];
      const settled = owned
        ? captureSessionControllerSettlement({
            scope: owned.session.storePath,
            identities: [owned.session.sessionKey, owned.session.entry?.sessionId],
          })
        : undefined;
      release.resolve();
      await settled;
      reloadDuringRead?.mockRestore();
      replaceAfterSelection?.mockRestore();
      holdDispatch.mockRestore();
      observeDispatch.mockRestore();
    }
  });
});
