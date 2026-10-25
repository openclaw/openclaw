import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveModelFallbackOptions } from "../../auto-reply/reply/agent-runner-run-params.js";
import { handleDirectiveOnly } from "../../auto-reply/reply/directive-handling.impl.js";
import { parseInlineSessionDirectives } from "../../auto-reply/reply/directive-handling.parse.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
} from "../../auto-reply/reply/queue.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../auto-reply/reply/queue/state.js";
import {
  prepareReplyAgentTurn,
  type AdmittedFollowupTurn,
} from "../../auto-reply/reply/reply-agent-turn-preparation.js";
import * as replyAdmission from "../../auto-reply/reply/reply-turn-admission.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptReports from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as sessionMailbox from "../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createSessionMutationCatalog,
  startSessionMutationRequest,
} from "./sessions-mutations.native-consent.test-support.js";
import { createSessionMutationTestContext } from "./sessions-mutations.owner.test-support.js";
import { setupSessionMutationState } from "./sessions-mutations.state.test-support.js";
import * as catalogPreparation from "./sessions-patch-catalog-preparation.js";
import type { GatewayRequestContext } from "./types.js";

// mock-isolation: Provider discovery is outside this synthetic session/queue preference boundary.
vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));
// mock-isolation: Keep paid inference and compaction side effects outside admission preference proof.
vi.mock("../../auto-reply/reply/agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry?: SessionEntry }) =>
    sessionEntry,
}));
// mock-isolation: Use the fixture config without ambient runtime or secret-Gateway state.
vi.mock("../../auto-reply/reply/agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: async (config: OpenClawConfig) => config,
}));

const withState = setupSessionMutationState();
const sessionKey = "agent:main:direct:queued-selection";
const sessionId = "queued-selection";
const catalog: ModelCatalogEntry[] = ["configured", "x", "y", "z"].map((id) => ({
  provider: "fixture",
  id,
  name: id,
  reasoning: id !== "z",
}));
const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: "fixture/configured",
      thinkingDefault: "medium",
      models: Object.fromEntries(catalog.map(({ id }) => [`fixture/${id}`, {}])),
    },
  },
};
const selectionX = { provider: "fixture", model: "x", thinkLevel: "low" } as const;
const selectionY = { provider: "fixture", model: "y", thinkLevel: "high" } as const;
const selectionZ = { provider: "fixture", model: "z", thinkLevel: "off" } as const;
const highX = { ...selectionX, thinkLevel: "high" } as const;
const offX = { ...selectionX, thinkLevel: "off" } as const;
const effortHigh = { thinkingLevel: "high" };
const effortOff = { thinkingLevel: "off" };
const modelY = { model: "fixture/y", ...effortHigh };
const modelZ = { model: "fixture/z", ...effortOff };
const scope = { agentId: "main", sessionKey };
const queuedAccount = {
  model: "y",
  modelOverrideSource: "auto" as const,
  hasAutoFallbackProvenance: true,
  authProfileId: "fixture:queued-account",
  authProfileIdSource: "user" as const,
};

async function admitQueued(
  state: OpenClawTestState,
  queued: FollowupRun,
  onQueuedFollowupAdmitted?: () => Promise<void>,
) {
  const result = await prepareReplyAgentTurn({
    queued,
    defaults: {
      typing: createTypingController({}),
      typingMode: "never" as const,
      defaultModel: "configured",
      sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionEntry: loadSessionEntry(scope),
      ...(onQueuedFollowupAdmitted ? { opts: { onQueuedFollowupAdmitted } } : {}),
    },
  });
  if (result.kind !== "admitted") {
    throw new Error("Follow-up was not admitted");
  }
  return result.turn;
}

afterEach(() => {
  clearFollowupQueue(sessionKey);
});

async function seedSession(thinkingLevel = "low", overrides: Partial<SessionEntry> = {}) {
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    providerOverride: "fixture",
    modelOverride: "x",
    modelOverrideSource: "user",
    thinkingLevel,
    ...overrides,
  });
}

async function patchSession(patch: Record<string, unknown>, config = cfg) {
  const params = { key: sessionKey, ...patch };
  const context = {
    ...createSessionMutationTestContext(config),
    loadGatewayModelCatalogSnapshot: async () =>
      createSessionMutationCatalog(
        config,
        { agentDir: () => "/fixture/agent", workspaceDir: "/fixture/workspace" },
        catalog,
      ),
    getSessionEventSubscriberConnIds: () => new Set(),
    dedupe: new Map(),
  } satisfies GatewayRequestContext;
  const { responses, running } = startSessionMutationRequest("sessions.patch", params, {
    req: { type: "req", id: "selection-patch", method: "sessions.patch", params },
    client: null,
    context,
  });
  await running;
  expect(responses).toHaveLength(1);
  return expectDefined(responses[0], "patch response");
}

it.each([false, true])(
  "records accepted model changes outside model context (incognito: %s)",
  (incognito) =>
    withState(async (state) => {
      const target = {
        ...scope,
        sessionKey: incognito ? "agent:main:dashboard:incognito-model-selection" : sessionKey,
        sessionId,
        storePath: incognito
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
          : path.join(state.sessionsDir(), "sessions.json"),
      };
      if (incognito) {
        await createSessionEntryWithTranscript(target, () => ({
          ok: true,
          entry: {
            sessionId,
            updatedAt: 1,
            incognito: true,
            providerOverride: "fixture",
            modelOverride: "x",
            modelOverrideSource: "user",
          },
        }));
      } else {
        await seedSession();
      }
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const message = { role: "user" as const, content: "Keep the conversation.", timestamp: 1 };
      await manager.appendMessageAsync(message);
      for (const [model, accepted] of [
        ["fixture/y", true],
        ["fixture/y", true],
        ["fixture/not-allowed", false],
        ["fixture/x", true],
      ] as const) {
        expect((await patchSession({ key: target.sessionKey, model }))[0]).toBe(accepted);
      }
      const followup = { role: "user" as const, content: "Continue.", timestamp: 2 };
      await manager.appendMessageAsync(followup);
      const reopened = await SessionManager.openAsync(target, state.workspaceDir);
      expect(reopened.getEntries()).toMatchObject([
        { type: "message", message },
        { customType: "session-model-change", display: true, details: { from: "x", to: "y" } },
        { customType: "session-model-change", display: true, details: { from: "y", to: "x" } },
        { type: "message", message: followup },
      ]);
      expect(reopened.buildSessionContext().messages).toEqual([message, followup]);
    }),
);

it("keeps an accepted model when its history notice cannot be saved", () =>
  withState(async () => {
    await seedSession();
    vi.spyOn(transcriptReports, "appendSessionTranscriptReport").mockRejectedValueOnce(
      new Error("fixture notice write failed"),
    );
    expect((await patchSession({ model: "fixture/y" }))[0]).toBe(true);
    expect(loadSessionEntry(scope)?.modelOverride).toBe("y");
  }));

it("preserves requested thinking when switching away from and back to a reasoning model", () =>
  withState(async () => {
    await seedSession("high");
    for (const model of ["fixture/z", "fixture/x"]) {
      expect((await patchSession({ model }))[0]).toBe(true);
      expect(loadSessionEntry(scope)?.thinkingLevel).toBe("high");
    }
  }));

function enqueue(
  state: OpenClawTestState,
  prompt: string,
  overrides: Partial<FollowupRun["run"]> = {},
) {
  const queued: FollowupRun = {
    prompt,
    enqueuedAt: 1,
    run: {
      agentId: "main",
      agentDir: state.agentDir("main"),
      sessionId,
      sessionKey,
      sessionFile: path.join(state.sessionsDir(), "queued-selection.jsonl"),
      workspaceDir: state.workspaceDir,
      config: cfg,
      ...selectionX,
      hasSessionModelOverride: true,
      modelOverrideSource: "user" as const,
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
      ...overrides,
    },
  };
  expect(enqueueFollowupRun(sessionKey, queued, { mode: "followup", debounceMs: 0 })).toBe(true);
  return queued;
}

it.each(["standard", null] as const)(
  "refreshes queued Access to %s without changing admitted turns",
  (program) =>
    withState(async (state) => {
      await seedSession("low", { cyberAccessProgram: "daybreak_blue" });
      const entered = [0, 1, 2].map(() => createDeferredCore<AdmittedFollowupTurn>());
      const release = [0, 1, 2].map(() => createDeferredCore());
      const finished = createDeferredCore();
      let index = 0;
      enqueue(state, "A", { cyberAccessProgram: "daybreak_blue" });
      const b = enqueue(state, "B", { cyberAccessProgram: "daybreak_blue" });
      const c = enqueue(state, "C", { cyberAccessProgram: "daybreak_blue" });
      // Observe errors even if an earlier assertion transfers control to cleanup.
      void finished.promise.catch(() => {});
      for (const gate of entered) {
        void gate.promise.catch(() => {});
      }
      scheduleFollowupDrain(sessionKey, async (queued) => {
        const current = index++;
        let turn: AdmittedFollowupTurn | undefined;
        try {
          turn = await admitQueued(state, queued);
          expectDefined(entered[current], "turn gate").resolve(turn);
          await expectDefined(release[current], "turn gate").promise;
        } catch (error) {
          expectDefined(entered[current], "turn gate").reject(error);
          finished.reject(error);
        } finally {
          turn?.operation.complete();
          if (current === 2) {
            finished.resolve();
          }
        }
      });
      try {
        const a = await expectDefined(entered[0], "turn gate").promise;
        expect(a.queued.run).toMatchObject(selectionX);
        expect((await patchSession({ cyberAccessProgram: program }))[0]).toBe(true);
        expect(loadSessionEntry(scope)?.cyberAccessProgram).toBe(program ?? undefined);
        expect([a.queued.run, b.run, c.run].map((run) => run.cyberAccessProgram)).toEqual([
          "daybreak_blue",
          program ?? undefined,
          program ?? undefined,
        ]);
        expect((await patchSession({ thinkingLevel: "high" }))[0]).toBe(true);
        expect([a.queued.run, b.run, c.run]).toMatchObject([selectionX, highX, highX]);
        expect((await patchSession({ model: "fixture/y", thinkingLevel: "high" }))[0]).toBe(true);
        expect([a.queued.run, b.run, c.run]).toMatchObject([selectionX, selectionY, selectionY]);

        expectDefined(release[0], "turn gate").resolve();
        const admittedB = await expectDefined(entered[1], "turn gate").promise;
        expect(admittedB.queued).toMatchObject({ prompt: "B", run: selectionY });
        expect(admittedB.queued.run.cyberAccessProgram).toBe(program ?? undefined);
        expect((await patchSession({ cyberAccessProgram: "daybreak_blue" }))[0]).toBe(true);
        expect(admittedB.queued.run.cyberAccessProgram).toBe(program ?? undefined);
        expect((await patchSession({ model: "fixture/z", thinkingLevel: "off" }))[0]).toBe(true);
        expect([a.queued.run, admittedB.queued.run, c.run]).toMatchObject([
          selectionX,
          selectionY,
          selectionZ,
        ]);

        expectDefined(release[1], "turn gate").resolve();
        const admittedC = await expectDefined(entered[2], "turn gate").promise;
        expect(admittedC.queued).toMatchObject({ prompt: "C", run: selectionZ });
        expect(admittedC.queued.run.cyberAccessProgram).toBe("daybreak_blue");
      } finally {
        for (const gate of release) {
          gate.resolve();
        }
        await finished.promise;
      }
    }),
);

it.each(["standard", null] as const)(
  "captures Access %s when its claimed source waits for reply admission",
  (program) =>
    withState(async (state) => {
      await seedSession("low", { cyberAccessProgram: "daybreak_blue" });
      const queued = enqueue(state, "waiting for admission", {
        cyberAccessProgram: "daybreak_blue",
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const admit = replyAdmission.admitReplyTurn;
      vi.spyOn(replyAdmission, "admitReplyTurn").mockImplementation(async (params) => {
        // The source has been claimed and its initial run copied. Keep real
        // admission behind an asynchronous boundary while the real patch commits.
        entered.resolve();
        await release.promise;
        return admit(params);
      });
      const starting = admitQueued(state, queued);
      void starting.catch(entered.reject);
      let turn: AdmittedFollowupTurn | undefined;
      try {
        await entered.promise;
        expect((await patchSession({ cyberAccessProgram: program }))[0]).toBe(true);
        expect(queued.run.cyberAccessProgram).toBe(program ?? undefined);
        release.resolve();
        turn = await starting;
        expect(turn.queued.run.cyberAccessProgram).toBe(program ?? undefined);
      } finally {
        release.resolve();
        turn ??= await starting;
        turn.operation.complete();
        const claim = queued.controllerInput?.claim;
        if (claim) {
          sessionMailbox.releaseSessionControllerClaim(claim);
          await claim.settlement.promise;
        }
      }
    }),
);

it.each([
  [{ thinkingLevel: "off" }, "off", "x"],
  [{ thinkingLevel: null }, "medium", "x"],
  [{ model: "fixture/y", thinkingLevel: "high" }, "high", "y"],
] as const)("refreshes %j without overriding turn thinking intent", (patch, expected, model) =>
  withState(async (state) => {
    await seedSession("high");
    const explicit = enqueue(state, "explicit low", {
      thinkLevel: "low",
      thinkLevelOverride: "low",
    });
    const defaults = enqueue(state, "explicit default", {
      thinkLevel: "medium",
      thinkLevelOverride: "default",
    });
    const ordinary = enqueue(state, "ordinary", { thinkLevel: "high" });

    expect((await patchSession(patch))[0]).toBe(true);
    expect(loadSessionEntry(scope)?.thinkingLevel).toBe(patch.thinkingLevel ?? undefined);
    expect([ordinary.run, explicit.run, defaults.run]).toMatchObject([
      { model, thinkLevel: expected },
      { model, thinkLevel: "low", thinkLevelOverride: "low" },
      { model, thinkLevel: "medium", thinkLevelOverride: "default" },
    ]);
    expect(getExistingFollowupQueue(sessionKey)?.lastRun?.thinkLevel).toBe(expected);
  }),
);

it("changes only effort on a queued fallback route", () =>
  withState(async (state) => {
    await seedSession();
    const queued = enqueue(state, "keep queued route", queuedAccount);
    expect((await patchSession({ thinkingLevel: "high" }))[0]).toBe(true);
    expect(queued.run).toMatchObject({ ...queuedAccount, thinkLevel: "high" });
  }));

it.each([null, "fixture/configured", "Fixture/configured", "preferred"])(
  "follows the agent default and retains fallbacks after selecting %s",
  (model) =>
    withState(async (state) => {
      const config = structuredClone(cfg);
      config.agents!.defaults!.model = "fixture/x";
      config.agents!.defaults!.models!["fixture/configured"] = { alias: "preferred" };
      config.agents!.entries = {
        main: { model: { primary: "fixture/configured", fallbacks: ["fixture/z"] } },
      };
      await seedSession("high", { modelOverrideSource: "auto" });
      const queued = enqueue(state, "reset", {
        config,
        thinkLevel: "high",
        hasAutoFallbackProvenance: true,
      });
      expect((await patchSession({ model, thinkingLevel: null }, config))[0]).toBe(true);
      const stored = loadSessionEntry(scope);
      expect(stored?.modelOverride).toBeUndefined();
      expect(stored?.providerOverride).toBeUndefined();
      expect(stored?.modelOverrideSource).toBe("default");
      expect(stored?.thinkingLevel).toBeUndefined();
      expect(queued.run).toMatchObject({
        provider: "fixture",
        model: "configured",
        thinkLevel: "medium",
        hasSessionModelOverride: false,
        modelOverrideSource: undefined,
      });
      expect(queued.run.hasAutoFallbackProvenance).toBeUndefined();
      expect(resolveModelFallbackOptions(queued.run).modelFallbackAvailability).toMatchObject({
        kind: "active",
        models: ["fixture/z"],
      });
      config.agents!.entries!.main!.model = "fixture/y";
      expect(resolveSessionModelRef(config, stored, "main")).toEqual({
        provider: "fixture",
        model: "y",
      });
    }),
);

it.each([
  { patch: { thinkingLevel: "not-a-level" }, error: "invalid thinkingLevel" },
  { patch: { model: "fixture/not-allowed", thinkingLevel: "high" }, error: "model not allowed" },
])("does not refresh or persist a rejected $patch patch", ({ patch, error }) =>
  withState(async (state) => {
    await seedSession();
    const queued = enqueue(state, "unchanged");
    const before = loadSessionEntry(scope);
    const response = await patchSession(patch);
    expect(response[0]).toBe(false);
    expect(response[2]?.message).toContain(error);
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(queued.run).toMatchObject(selectionX);
  }),
);

it.each([
  ["/think high", "high", "high"],
  ["/think default", "medium", undefined],
  ["/think invalid", "low", "low"],
] as const)(
  "publishes %s without replacing waiting turns' route or thinking intent",
  (command, expected, stored) =>
    withState(async (state) => {
      await seedSession();
      const route = {
        ...queuedAccount,
        requestedRouteResolution: "resolved" as const,
        autoFallbackPrimaryProbe: {
          provider: "fixture",
          model: "y",
          fallbackProvider: "fixture",
          fallbackModel: "configured",
        },
      };
      const ordinary = enqueue(state, "ordinary", route);
      const explicit = enqueue(state, "explicit low", { ...route, thinkLevelOverride: "low" });
      const defaults = enqueue(state, "explicit default", {
        ...route,
        thinkLevel: "medium",
        thinkLevelOverride: "default",
      });
      const sessionEntry = expectDefined(loadSessionEntry(scope), "session entry");
      const reply = await handleDirectiveOnly({
        cfg,
        agentId: "main",
        sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        directives: parseInlineSessionDirectives(command),
        elevatedEnabled: false,
        elevatedAllowed: false,
        defaultProvider: "fixture",
        defaultModel: "configured",
        provider: "fixture",
        model: "x",
        initialModelLabel: "fixture/x",
        formatModelSwitchEvent: (label) => label,
        aliasIndex: { byAlias: new Map(), byKey: new Map() },
        allowedModelKeys: new Set(catalog.map(({ id }) => `fixture/${id}`)),
        allowedModelCatalog: catalog,
        resetModelOverride: false,
        messageProvider: "telegram",
        commandAuthorized: true,
      });
      expect(reply?.text).toContain(
        command === "/think invalid" ? "Unrecognized thinking level" : "Thinking level",
      );
      expect(loadSessionEntry(scope)?.thinkingLevel).toBe(stored);
      expect([ordinary.run, explicit.run, defaults.run]).toMatchObject([
        { ...route, thinkLevel: expected },
        { ...route, thinkLevel: "low", thinkLevelOverride: "low" },
        { ...route, thinkLevel: "medium", thinkLevelOverride: "default" },
      ]);
    }),
);

it.each([
  [effortHigh, highX, effortOff, offX, false],
  [modelY, selectionY, modelZ, selectionZ, true],
  [effortHigh, highX, modelZ, selectionZ, true],
  [
    { cyberAccessProgram: "standard" },
    { ...selectionX, cyberAccessProgram: "standard" },
    { cyberAccessProgram: null },
    { ...selectionX, cyberAccessProgram: undefined },
    false,
  ],
] as const)(
  "binds %j at writer-ordered admission (selection %j, later %j, next %j, probe=%s)",
  (patch, selected, later, next, probe) =>
    withState(async (state) => {
      await seedSession("low", {
        cyberAccessProgram: "daybreak_blue",
        ...(probe
          ? {
              modelOverride: "configured",
              modelOverrideSource: "auto",
              modelOverrideFallbackOriginProvider: "fixture",
              modelOverrideFallbackOriginModel: "x",
            }
          : {}),
      });
      const b = enqueue(state, "B waiting for settings", {
        cyberAccessProgram: "daybreak_blue",
        autoFallbackPrimaryProbe: probe
          ? {
              provider: "fixture",
              model: "x",
              fallbackProvider: "fixture",
              fallbackModel: "configured",
            }
          : undefined,
      });
      const c = enqueue(state, "C still waiting", { cyberAccessProgram: "daybreak_blue" });
      const committed = createDeferredCore();
      const releaseRefresh = createDeferredCore();
      const requestingClaim = createDeferredCore();
      const prepareCatalog = catalogPreparation.createSessionPatchCatalogPreparation;
      let held = false;
      vi.spyOn(catalogPreparation, "createSessionPatchCatalogPreparation").mockImplementation(
        (...args) => {
          const owner = prepareCatalog(...args);
          return {
            ...owner,
            available: async (agentId) => {
              const availableCatalog = await owner.available(agentId);
              // The real patch has committed, but still holds lifecycle ordering
              // while preparing its queue publication. Let B try to start here.
              if (
                !held &&
                (loadSessionEntry(scope)?.thinkingLevel === "high" ||
                  loadSessionEntry(scope)?.cyberAccessProgram === "standard")
              ) {
                held = true;
                committed.resolve();
                await releaseRefresh.promise;
              }
              return availableCatalog;
            },
          };
        },
      );
      const requestClaim = sessionMailbox.claimSessionControllerInput;
      vi.spyOn(sessionMailbox, "claimSessionControllerInput").mockImplementation((queued) => {
        const result = requestClaim(queued);
        requestingClaim.resolve();
        return result;
      });
      const changing = patchSession(patch);
      void changing.catch(committed.reject);
      let starting: ReturnType<typeof admitQueued> | undefined;
      let turn: AdmittedFollowupTurn | undefined;
      try {
        await committed.promise;
        expect(b.run).toMatchObject(selectionX);
        starting = admitQueued(state, b, async () => {
          // Source adoption is awaited after admission. A newer write here
          // must affect C without changing the already admitted B snapshot.
          expect((await patchSession(later))[0]).toBe(true);
        });
        void starting.catch(requestingClaim.reject);
        await requestingClaim.promise;
        // The writer fence holds mailbox selection before reply admission begins.
        expect(expectDefined(b.controllerInput, "queued input").claim).toBeUndefined();
        releaseRefresh.resolve();
        expect((await changing)[0]).toBe(true);
        turn = await starting;
        expect(turn.queued.run).toMatchObject(selected);
        expect(c.run).toMatchObject(next);
        expect(getExistingFollowupQueue(sessionKey)?.lastRun).toMatchObject(next);
      } finally {
        releaseRefresh.resolve();
        await changing;
        turn ??= await starting;
        turn?.operation.complete();
        const claim = b.controllerInput?.claim;
        if (claim) {
          sessionMailbox.releaseSessionControllerClaim(claim);
          await claim.settlement.promise;
        }
      }
    }),
);
