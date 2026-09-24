import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { readSessionPendingInputByKey } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import * as sessionUtils from "../session-utils.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

const admissionScenarios = [
  "removed",
  "replaced",
  "aborted",
  "released",
  "terminal",
  "rotated",
  "queued",
  "narrow-first-send",
  "dashboard",
  "dashboard-writer",
  "dashboard-credential-revoked",
  "dashboard-member-revoked",
  "dashboard-unattested",
  "dashboard-internal",
] as const;

it.each(admissionScenarios)(
  "keeps prepared-session binding with its exact admission: %s",
  async (scenario) => {
    const dashboard = scenario.startsWith("dashboard");
    const directDashboard = dashboard && scenario !== "dashboard-internal";
    const dashboardReadAllowed = directDashboard && scenario !== "dashboard-unattested";
    const membershipRequired = scenario === "dashboard-member-revoked";
    const closure =
      scenario === "narrow-first-send"
        ? "rotated"
        : scenario === "dashboard-writer"
          ? "aborted"
          : dashboard
            ? "released"
            : scenario;
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const runId = "retained-preparation";
      const sessionKey = scenario === "dashboard" ? "agent:main:main" : "agent:main:binding";
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated-session", updatedAt: Date.now() },
      );
      const clone = vi.spyOn(globalThis, "structuredClone");
      const unrelatedCloneCount = () =>
        clone.mock.calls.filter(
          ([entry]) =>
            entry &&
            typeof entry === "object" &&
            "sessionId" in entry &&
            entry.sessionId === "unrelated-session",
        ).length;
      const profile = ensureProfileForEmail("authoring-binding@example.test");
      const owner = membershipRequired
        ? ensureProfileForEmail("authoring-owner@example.test")
        : profile;
      const initialSessionId = membershipRequired ? "member-session" : runId;
      const createdActor = { type: "human", source: "profile", id: owner.id } as const;
      if (membershipRequired) {
        await upsertSessionEntryCore(scope, {
          sessionId: initialSessionId,
          updatedAt: Date.now(),
          visibility: "suggest",
          createdActor,
        });
        addSessionMember(scope, { identityId: profile.id, addedBy: owner.id });
      }
      const connection = new AbortController();
      const hasCurrentClientAuthority = vi.fn(() => true);
      const client: GatewayClient = {
        connId: "authoring-binding",
        connectionSignal: connection.signal,
        ...(dashboard && scenario !== "dashboard-unattested"
          ? {
              internal: {
                authenticatedControlUi: true as const,
                ...(scenario !== "dashboard-writer" && !membershipRequired
                  ? { controlUiAdmin: true as const }
                  : {}),
              },
            }
          : {}),
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes:
            scenario === "narrow-first-send"
              ? ["operator.sessions.write"]
              : scenario === "dashboard-writer" || membershipRequired
                ? ["operator.write"]
                : dashboard
                  ? ["operator.admin"]
                  : ["operator.read", "operator.write", "operator.admin"],
          client: dashboard
            ? { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" }
            : { id: "cli", version: "test", platform: "test", mode: "cli" },
        },
      };
      const namespaceRun = prepareSystemAgentRunAdmission({}, runId, "main", "test");
      const entered = createDeferred<DispatchOptions>();
      const release = createDeferred();
      const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      const holdDispatch = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          entered.resolve(options);
          await release.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        });
      const context = {
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        chatRunState: createChatRunState(),
        dedupe: new Map(),
        agentRunSeq: new Map(),
        getRuntimeConfig,
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      } as unknown as GatewayRequestContext;
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      let successor: ReturnType<typeof registerChatAbortController> | undefined;
      let options: DispatchOptions | undefined;
      try {
        const respond = vi.fn();
        const params = {
          // Exercise the ordinary dashboard alias without an explicit agentId.
          sessionKey: scenario === "dashboard" ? "main" : sessionKey,
          message: "Keep this user turn in its session",
          idempotencyKey: runId,
        };
        const authorization = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(authorization.error).toBeNull();
        const sendChat = directDashboard ? handleDirectExternalChatSend : handleChatSend;
        const request = {
          params,
          req: { type: "req" as const, id: runId, method: "chat.send", params },
          respond,
          context,
          client,
          hasCurrentClientAuthority,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        };
        if (scenario === "narrow-first-send") {
          await handleGatewayRequest({
            ...request,
            extraHandlers: { "chat.send": handleChatSend },
          });
        } else {
          await sendChat(request);
        }
        expect(respond).toHaveBeenCalledWith(
          true,
          dashboard
            ? expect.objectContaining({ runId, status: "started" })
            : { runId, status: "started" },
          undefined,
          expect.anything(),
        );
        options = await entered.promise;
        const dashboardRead = options.replyOptions?.dashboardReadAdmission;
        expect(Boolean(dashboardRead)).toBe(dashboardReadAllowed);
        owned = observeDispatch.mock.calls.at(-1)?.[0];
        const prepared = options.replyOptions?.onSessionPrepared;
        const runStarted = options.replyOptions?.onAgentRunStart;
        if (!owned || !prepared || !runStarted || !owned.skillLibraryAuthoring) {
          throw new Error("chat.send did not hand off its prepared-session callback");
        }
        // Initial resolution needs detached entries; later admission must not clone unrelated rows.
        expect.soft(unrelatedCloneCount()).toBeLessThanOrEqual(1);
        const capability = owned.skillLibraryAuthoring;
        const admittedContext = await namespaceRun.admit("embedded");
        capability.bind(admittedContext);
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admittedContext,
          agentId: "main",
          sessionKey,
        });
        const readLibrary = () =>
          withGatewayToolCallerIdentity(caller, () => capability.invoke({ action: "list" }));
        const { admission, userTurn } = owned;
        const original = admission.activeRunAbort.entry;
        expect(original?.sessionId).toBe(initialSessionId);
        // This focused test controls preparation; the native WS test proves its real producer.
        await upsertSessionEntryCore(scope, {
          sessionId: membershipRequired ? initialSessionId : "committed-session",
          updatedAt: Date.now(),
          createdActor,
          ...(membershipRequired ? { visibility: "suggest" as const } : {}),
        });
        const committed = loadExactSessionEntryReadOnly(scope);
        if (!committed) {
          throw new Error("session writer did not commit");
        }
        const binding = {
          sessionKey,
          sessionId: committed.entry.sessionId,
          storePath: owned.session.storePath,
        };
        prepared(binding);
        prepared(binding);
        prepared({ ...binding, sessionKey: "agent:main:unrelated", sessionId: "foreign" });
        if (dashboardRead) {
          expect(admission.admittedSessionId).toBe(initialSessionId);
          expect(dashboardRead.sessionId).toBe(binding.sessionId);
          dashboardRead.assertCurrent();
        }
        clone.mockClear();
        runStarted(runId);
        expect.soft(unrelatedCloneCount()).toBe(0);
        await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        if (dashboardRead) {
          connection.abort();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
          expect(dashboardRead.assertCurrent).not.toThrow();
          if (scenario === "dashboard-credential-revoked") {
            hasCurrentClientAuthority.mockReturnValue(false);
            expect(dashboardRead.assertCurrent).toThrow(
              "Dashboard message read admission is no longer active.",
            );
          } else if (membershipRequired) {
            removeSessionMember(scope, profile.id, undefined, binding.sessionId);
            expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
            expect(hasCurrentClientAuthority()).toBe(true);
            expect(dashboardRead.assertCurrent).toThrow("session is suggest for this connection");
          }
        }

        if (closure === "queued") {
          expect(original?.sessionId).toBe(binding.sessionId);
          expect(admission.admittedSessionId).toBe(runId);
          expect(options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
          expect(context.chatQueuedTurns.get(runId)?.sessionId).toBe(binding.sessionId);
          await userTurn.persist();
          expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
            expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
          );
          admission.cleanupAdmittedRun();
          expect(context.chatQueuedTurns.has(runId)).toBe(true);
        } else if (closure === "removed" || closure === "replaced") {
          admission.activeRunAbort.cleanup();
          if (closure === "replaced") {
            successor = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionKey,
              sessionId: "successor-session",
              timeoutMs: 60_000,
            });
          }
        } else if (closure === "aborted") {
          admission.activeRunAbort.controller.abort();
        } else if (closure === "released") {
          admission.gatewayWorkAdmission.release();
        } else if (closure === "terminal") {
          reply = createReplyOperation({
            sessionKey,
            sessionId: binding.sessionId,
            resetTriggered: false,
            upstreamAbortSignal: admission.activeRunAbort.controller.signal,
          });
          reply.complete();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        // No await after closure: release must fence even before its promise settles.
        expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
        if (dashboardRead) {
          expect(dashboardRead.assertCurrent).toThrow();
        }
        expect(original?.sessionId).toBe(binding.sessionId);
        expect(successor?.entry?.sessionId).toBe(
          closure === "replaced" ? "successor-session" : undefined,
        );
        if (closure === "queued") {
          await expect(readLibrary()).resolves.toMatchObject({ profileId: profile.id });
        } else if (closure === "released" || closure === "aborted" || closure === "rotated") {
          await expect(readLibrary()).rejects.toThrow();
        }
        if (closure !== "queued") {
          await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
          await userTurn.persist();
          expect(
            await loadTranscriptEvents({
              ...scope,
              sessionId: "late-session",
              storePath: binding.storePath,
            }),
          ).toEqual([]);
        }
      } finally {
        namespaceRun.close();
        options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
        reply?.complete();
        successor?.cleanup();
        release.resolve();
        if (owned) {
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
          owned.admission.cleanupAdmittedRun();
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
        holdDispatch.mockRestore();
        observeDispatch.mockRestore();
        clone.mockRestore();
      }
    });
  },
);

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
    const originalPath = state.path("original.sqlite");
    const replacementPath = state.path("replacement.sqlite");
    if (scenario.replaceDatabase === "symlink") {
      closeOpenClawAgentDatabaseByPath(storePath);
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
      };
      sending = handleDirectExternalChatSend(
        {
          params,
          req: { type: "req", id: runId, method: "chat.send", params },
          respond,
          context,
          client: null,
          isWebchatConnect: () => false,
        },
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
            ...rows[0]!,
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
      const selected = rows.find((row) => row.sessionKey === scenario.key)!;
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
      replaceAfterSelection?.mockRestore();
      holdDispatch.mockRestore();
      observeDispatch.mockRestore();
    }
  });
});
