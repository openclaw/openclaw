import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { handleDirectiveOnly } from "../../auto-reply/reply/directive-handling.impl.js";
import { parseInlineSessionDirectives } from "../../auto-reply/reply/directive-handling.parse.js";
import {
  admitFollowupTurn,
  type AdmittedFollowupTurn,
} from "../../auto-reply/reply/followup-turn-admission.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
} from "../../auto-reply/reply/queue.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../auto-reply/reply/queue/state.js";
import * as replyAdmission from "../../auto-reply/reply/reply-turn-admission.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { createSessionMutationTestContext } from "./sessions-mutations.owner.test-support.js";
import { setupSessionMutationState } from "./sessions-mutations.state.test-support.js";
import * as catalogPreparation from "./sessions-patch-catalog-preparation.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

// Keep provider discovery and compaction out of this session/queue boundary test.
// Patch validation, persistence, refresh, drain, and follow-up admission stay real.
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
  resolveQueuedReplyRuntimeConfig: (config: OpenClawConfig) => config,
}));

const withState = setupSessionMutationState();
const sessionKey = "agent:main:direct:queued-selection";
const sessionId = "queued-selection";
const catalog: ModelCatalogEntry[] = ["configured", "x", "y", "z"].map((id) => ({
  provider: "fixture",
  id,
  name: id,
  reasoning: true,
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

afterEach(() => {
  clearFollowupQueue(sessionKey);
});

async function seedSession(thinkingLevel = "low", overrides: Partial<SessionEntry> = {}) {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId,
      updatedAt: 1,
      providerOverride: "fixture",
      modelOverride: "x",
      modelOverrideSource: "user",
      thinkingLevel,
      ...overrides,
    },
  );
}

async function patchSession(patch: Record<string, unknown>) {
  const params = { key: sessionKey, ...patch };
  const responses: Parameters<RespondFn>[] = [];
  const context = {
    ...createSessionMutationTestContext(cfg),
    loadGatewayModelCatalogSnapshot: async () => ({
      agentId: "main",
      agentDir: "/fixture/agent",
      workspaceDir: "/fixture/workspace",
      config: cfg,
      catalogComplete: true,
      entries: catalog,
      routeVariants: catalog,
    }),
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } satisfies GatewayRequestContext;
  await expectDefined(
    sessionMutationHandlers["sessions.patch"],
    "patch handler",
  )({
    req: { type: "req", id: "selection-patch", method: "sessions.patch", params },
    params,
    client: null,
    context,
    isWebchatConnect: () => true,
    respond: (...response) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  return expectDefined(responses[0], "patch response");
}

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
      modelOverrideSource: "user",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
      ...overrides,
    },
  };
  expect(enqueueFollowupRun(sessionKey, queued, { mode: "followup", debounceMs: 0 })).toBe(true);
  return queued;
}

it("keeps admitted A on X, starts queued B on Y, and applies a later Z only to waiting C", async () => {
  await withState(async (state) => {
    await seedSession();
    const entered = [0, 1, 2].map(() => createDeferredCore<AdmittedFollowupTurn>());
    const release = [0, 1, 2].map(() => createDeferredCore());
    const finished = createDeferredCore();
    let index = 0;
    enqueue(state, "A");
    const b = enqueue(state, "B");
    const c = enqueue(state, "C");
    // Observe errors even if an earlier assertion transfers control to cleanup.
    void finished.promise.catch(() => {});
    for (const gate of entered) {
      void gate.promise.catch(() => {});
    }
    scheduleFollowupDrain(sessionKey, async (queued) => {
      const current = index++;
      let turn: AdmittedFollowupTurn | undefined;
      try {
        const result = await admitFollowupTurn({
          queued,
          defaults: {
            typing: createTypingController({}),
            typingMode: "never",
            defaultModel: "configured",
            sessionKey,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
            sessionEntry: loadSessionEntry({ agentId: "main", sessionKey }),
          },
        });
        expect(result.kind).toBe("admitted");
        if (result.kind !== "admitted") {
          throw new Error("Follow-up was not admitted");
        }
        turn = result.turn;
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
      expect((await patchSession({ thinkingLevel: "high" }))[0]).toBe(true);
      expect(a.queued.run).toMatchObject(selectionX);
      expect(b.run).toMatchObject({ ...selectionX, thinkLevel: "high" });
      expect(c.run).toMatchObject({ ...selectionX, thinkLevel: "high" });
      expect((await patchSession({ model: "fixture/y", thinkingLevel: "high" }))[0]).toBe(true);
      expect(a.queued.run).toMatchObject(selectionX);
      expect(b.run).toMatchObject(selectionY);
      expect(c.run).toMatchObject(selectionY);

      expectDefined(release[0], "turn gate").resolve();
      const admittedB = await expectDefined(entered[1], "turn gate").promise;
      expect(admittedB.queued.prompt).toBe("B");
      expect(admittedB.queued.run).toMatchObject(selectionY);
      expect((await patchSession({ model: "fixture/z", thinkingLevel: "off" }))[0]).toBe(true);
      expect(a.queued.run).toMatchObject(selectionX);
      expect(admittedB.queued.run).toMatchObject(selectionY);
      expect(c.run).toMatchObject(selectionZ);

      expectDefined(release[1], "turn gate").resolve();
      const admittedC = await expectDefined(entered[2], "turn gate").promise;
      expect(admittedC.queued.prompt).toBe("C");
      expect(admittedC.queued.run).toMatchObject(selectionZ);
    } finally {
      for (const gate of release) {
        gate.resolve();
      }
      await finished.promise;
    }
  });
});

it.each([
  { patch: { thinkingLevel: "off" }, expected: "off", model: "x" },
  { patch: { thinkingLevel: null }, expected: "medium", model: "x" },
  { patch: { model: "fixture/y", thinkingLevel: "high" }, expected: "high", model: "y" },
])(
  "refreshes $patch without overriding turn thinking intent",
  async ({ patch, expected, model }) => {
    await withState(async (state) => {
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
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.thinkingLevel).toBe(
        patch.thinkingLevel ?? undefined,
      );
      expect(ordinary.run).toMatchObject({ model, thinkLevel: expected });
      expect(explicit.run).toMatchObject({ model, thinkLevel: "low", thinkLevelOverride: "low" });
      expect(defaults.run).toMatchObject({
        model,
        thinkLevel: "medium",
        thinkLevelOverride: "default",
      });
      expect(getExistingFollowupQueue(sessionKey)?.lastRun?.thinkLevel).toBe(expected);
    });
  },
);

it("changes only effort on a queued fallback route", async () => {
  await withState(async (state) => {
    await seedSession();
    const route = {
      model: "y",
      modelOverrideSource: "auto" as const,
      hasAutoFallbackProvenance: true,
      authProfileId: "fixture:queued-account",
      authProfileIdSource: "user" as const,
    };
    const queued = enqueue(state, "keep queued route", route);
    expect((await patchSession({ thinkingLevel: "high" }))[0]).toBe(true);
    expect(queued.run).toMatchObject({ ...route, thinkLevel: "high" });
  });
});

it("clears queued model and thinking overrides after the reset commits", async () => {
  await withState(async (state) => {
    await seedSession("high");
    const queued = enqueue(state, "reset", { thinkLevel: "high", hasAutoFallbackProvenance: true });
    expect((await patchSession({ model: null, thinkingLevel: null }))[0]).toBe(true);
    const stored = loadSessionEntry({ agentId: "main", sessionKey });
    expect(stored?.modelOverride).toBeUndefined();
    expect(stored?.thinkingLevel).toBeUndefined();
    expect(queued.run).toMatchObject({
      provider: "fixture",
      model: "configured",
      thinkLevel: "medium",
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
    });
    expect(queued.run.hasAutoFallbackProvenance).toBeUndefined();
  });
});

it.each([
  { patch: { thinkingLevel: "not-a-level" }, error: "invalid thinkingLevel" },
  { patch: { model: "fixture/not-allowed", thinkingLevel: "high" }, error: "model not allowed" },
])("does not refresh or persist a rejected $patch patch", async ({ patch, error }) => {
  await withState(async (state) => {
    await seedSession();
    const queued = enqueue(state, "unchanged");
    const before = loadSessionEntry({ agentId: "main", sessionKey });
    const response = await patchSession(patch);
    expect(response[0]).toBe(false);
    expect(response[2]?.message).toContain(error);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toEqual(before);
    expect(queued.run).toMatchObject(selectionX);
  });
});

it.each([
  { command: "/think high", expected: "high", stored: "high" },
  { command: "/think default", expected: "medium", stored: undefined },
  { command: "/think invalid", expected: "low", stored: "low" },
])(
  "publishes $command to waiting turns without replacing their route or thinking intent",
  async ({ command, expected, stored }) => {
    await withState(async (state) => {
      await seedSession();
      const route = {
        model: "y",
        requestedRouteResolution: "resolved" as const,
        modelOverrideSource: "auto" as const,
        hasAutoFallbackProvenance: true,
        authProfileId: "fixture:queued-account",
        authProfileIdSource: "user" as const,
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
      const sessionEntry = expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey }),
        "session entry",
      );
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
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.thinkingLevel).toBe(stored);
      expect(ordinary.run).toMatchObject({ ...route, thinkLevel: expected });
      expect(explicit.run).toMatchObject({
        ...route,
        thinkLevel: "low",
        thinkLevelOverride: "low",
      });
      expect(defaults.run).toMatchObject({
        ...route,
        thinkLevel: "medium",
        thinkLevelOverride: "default",
      });
    });
  },
);

it.each([
  {
    name: "effort",
    patch: { thinkingLevel: "high" },
    selected: { ...selectionX, thinkLevel: "high" },
    later: { thinkingLevel: "off" },
    next: { ...selectionX, thinkLevel: "off" },
    probe: false,
  },
  {
    name: "model with a queued primary probe",
    patch: { model: "fixture/y", thinkingLevel: "high" },
    selected: selectionY,
    later: { model: "fixture/z", thinkingLevel: "off" },
    next: selectionZ,
    probe: true,
  },
  {
    name: "effort with a queued primary probe",
    patch: { thinkingLevel: "high" },
    selected: { ...selectionX, thinkLevel: "high" },
    later: { model: "fixture/z", thinkingLevel: "off" },
    next: selectionZ,
    probe: true,
  },
])(
  "binds $name at the writer-ordered queued admission, not before or after it",
  async ({ patch, selected, later, next, probe }) => {
    await withState(async (state) => {
      await seedSession(
        "low",
        probe
          ? {
              modelOverride: "configured",
              modelOverrideSource: "auto",
              modelOverrideFallbackOriginProvider: "fixture",
              modelOverrideFallbackOriginModel: "x",
            }
          : {},
      );
      const b = enqueue(state, "B waiting for settings", {
        autoFallbackPrimaryProbe: probe
          ? {
              provider: "fixture",
              model: "x",
              fallbackProvider: "fixture",
              fallbackModel: "configured",
            }
          : undefined,
      });
      const c = enqueue(state, "C still waiting");
      const committed = createDeferredCore();
      const releaseRefresh = createDeferredCore();
      const enteringAdmission = createDeferredCore();
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
                loadSessionEntry({ agentId: "main", sessionKey })?.thinkingLevel === "high"
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
      const admit = replyAdmission.admitReplyTurn;
      vi.spyOn(replyAdmission, "admitReplyTurn").mockImplementation((params) => {
        const result = admit(params);
        enteringAdmission.resolve();
        return result;
      });
      const changing = patchSession(patch);
      void changing.catch(committed.reject);
      let starting: ReturnType<typeof admitFollowupTurn> | undefined;
      let result: Awaited<ReturnType<typeof admitFollowupTurn>> | undefined;
      try {
        await committed.promise;
        expect(b.run).toMatchObject(selectionX);
        starting = admitFollowupTurn({
          queued: b,
          defaults: {
            typing: createTypingController({}),
            typingMode: "never",
            defaultModel: "configured",
            sessionKey,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
            sessionEntry: loadSessionEntry({ agentId: "main", sessionKey }),
            opts: {
              onQueuedFollowupAdmitted: async () => {
                // Source adoption is awaited after admission. A newer write here
                // must affect C without changing the already admitted B snapshot.
                expect((await patchSession(later))[0]).toBe(true);
              },
            },
          },
        });
        void starting.catch(enteringAdmission.reject);
        await enteringAdmission.promise;
        releaseRefresh.resolve();
        expect((await changing)[0]).toBe(true);
        result = await starting;
        expect(result.kind).toBe("admitted");
        if (result.kind !== "admitted") {
          throw new Error("Follow-up was not admitted");
        }
        expect(result.turn.queued.run).toMatchObject(selected);
        expect(c.run).toMatchObject(next);
        expect(getExistingFollowupQueue(sessionKey)?.lastRun).toMatchObject(next);
      } finally {
        releaseRefresh.resolve();
        await changing;
        result ??= await starting;
        if (result?.kind === "admitted") {
          result.turn.operation.complete();
        }
      }
    });
  },
);
