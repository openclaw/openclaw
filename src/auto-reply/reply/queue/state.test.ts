import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../../cron/scheduled-occurrence.test-support.js";
import {
  submitSessionControllerInput,
  retireSessionControllerInput,
  reserveSessionControllerSource,
  bindSessionControllerSource,
  sessionControllerMailboxes,
  releaseSessionControllerClaim,
  tryClaimSessionControllerTask,
  type SessionControllerMailbox,
} from "../../../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import type { ScheduledSessionAutomation } from "../session-event-contract.js";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  clearFollowupQueue,
  clearRemovedQueuedAuthProfiles,
  getFollowupQueue,
  hasPendingFollowupQueueWork,
  refreshQueuedFollowupSession,
} from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";

async function clearOwnedQueues() {
  // Capture owners before cleanup can mutate the registry or publish a successor.
  const capturedOwners = Array.from(sessionControllerMailboxes());
  for (const queue of capturedOwners) {
    if (!queue.owner.aliases.has(QUEUE_KEY)) {
      continue;
    }
    const sources = [
      ...queue.entries.flatMap((input) => (input.source ? [input.source] : [])),
      ...queue.summarySources,
      ...queue.summaryElisions.flatMap((part) => part.sources),
    ];
    // Metadata-only summary fixtures still retire through the exact physical
    // queue they were inserted into, not through a newly inferred config path.
    for (const source of sources) {
      if (!source.controllerInput) {
        const input = reserveSessionControllerSource(queue.key, {
          target: queue.owner.target,
          policy: { mode: queue.mode },
        });
        bindSessionControllerSource(input, source);
      }
    }
    const inputs = [...queue.entries];
    const claim = queue.claim;
    clearFollowupQueue(QUEUE_KEY, queue);
    if (claim) {
      releaseSessionControllerClaim(claim);
    }
    await Promise.allSettled([
      ...inputs.map((input) => input.settlement.promise),
      ...sources.flatMap((source) =>
        source.controllerInput ? [source.controllerInput.settlement.promise] : [],
      ),
      ...(claim ? [claim.settlement.promise] : []),
    ]);
  }
}
afterEach(clearOwnedQueues);

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey: QUEUE_KEY,
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    config: { session: { store: "/synthetic/queue-state/sessions.sqlite" } },
    provider: "anthropic",
    model: "claude-opus-4-6",
    requestedRouteResolution: "resolved",
    authProfileId: "profile-a",
    authProfileIdSource: "user",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
    ...overrides,
  };
}

function makeSource(run = makeRun(), prompt = "queued message", enqueuedAt = 1): FollowupRun {
  return { prompt, enqueuedAt, run };
}

function elision(sources: FollowupRun[], contextKey = "context", count = sources.length) {
  return {
    contextKey,
    count,
    sources,
    summaryLines: sources.map((item) => item.prompt),
    sourceRefs: new Map<FollowupRun, FollowupRun>(),
  };
}

function populateRepresentations(
  queue: SessionControllerMailbox,
  overrides: Partial<FollowupRun["run"]> = {},
) {
  const runs = Array.from({ length: 4 }, () => makeRun(overrides));
  queue.lastRun = runs[0];
  addSources(queue, makeSource(runs[1]!));
  queue.summarySources.push(makeSource(runs[2]!));
  queue.summaryElisions.push(elision([makeSource(runs[3]!)]));
  return runs;
}

function refresh(params: Omit<Parameters<typeof refreshQueuedFollowupSession>[0], "key">) {
  refreshQueuedFollowupSession({ key: QUEUE_KEY, ...params });
}

function route(
  nextProvider: string,
  nextModel: string,
  overrides: Parameters<typeof refresh>[0] = {},
): Parameters<typeof refresh>[0] {
  return { nextProvider, nextModel, nextRouteResolution: "resolved", ...overrides };
}

function thinkingRoute(model: string, level?: string, reasoning = true) {
  return {
    nextProvider: "openai",
    nextModel: model,
    nextThinking: {
      level,
      catalog: reasoningModel(model, model, reasoning),
      agentRuntime: "codex",
    },
  };
}

function retarget(run: Partial<FollowupRun["run"]>, params: Parameters<typeof refresh>[0]) {
  const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
  addSources(queue, makeSource(makeRun(run)));
  refresh(params);
  return queue.items[0]?.run;
}

function scheduledAutomation(sessionModelOverrideSource?: "auto" | "user") {
  return {
    occurrence: TEST_SCHEDULED_OCCURRENCE,
    job: makeCronJob({ sessionTarget: `session:${QUEUE_KEY}` }),
    admissionSource: "operator-schedule",
    assertCurrent() {},
    modelFallbackPolicy: {
      useSubagentFallbacks: false,
      inheritDefaultFallbacksForAgentStringModel: false,
      ...(sessionModelOverrideSource ? { sessionModelOverrideSource } : {}),
    },
  } satisfies ScheduledSessionAutomation;
}

const modelThinking = (thinking: string) => ({ params: { thinking } });
type Agents = NonNullable<FollowupRun["run"]["config"]["agents"]>;
function thinkingConfig(defaults: Agents["defaults"], entries?: Agents["entries"]) {
  return { agents: { defaults, entries } };
}
const reasoningModel = (id: string, name = id, reasoning = true) => [
  { provider: "openai", id, name, reasoning },
];
const highModel = { "openai/gpt-5.6-sol": modelThinking("high") };

describe("clearRemovedQueuedAuthProfiles", () => {
  it("releases removed accounts in every queued source without replacing newer choices", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const [lastRun, queued, summarized, elided] = [makeRun(), makeRun(), makeRun(), makeRun()];
    const newer = { ...makeRun(), authProfileId: "profile-b" };
    const otherAgent = { ...makeRun(), agentId: "other" };
    const retainedConfig = otherAgent.config;
    queued.autoFallbackPrimaryProbe = {
      provider: "anthropic",
      model: "primary",
      fallbackProvider: "anthropic",
      fallbackModel: queued.model,
      fallbackAuthProfileId: "profile-a",
      fallbackAuthProfileIdSource: "auto",
    };
    newer.autoFallbackPrimaryProbe = {
      ...queued.autoFallbackPrimaryProbe,
      fallbackAuthProfileId: "profile-b",
    };
    queue.lastRun = lastRun;
    const otherAgentSource = makeSource(otherAgent);
    addSources(queue, makeSource(queued), makeSource(newer), otherAgentSource);
    queue.summarySources.push(makeSource(summarized));
    queue.summaryElisions.push(elision([makeSource(elided)]));
    const rewrittenConfig = { agents: { entries: { main: { model: "anthropic/model" } } } };

    clearRemovedQueuedAuthProfiles({
      removedByAgent: new Map([["main", new Set(["profile-a"])]]),
      rewriteConfig: () => rewrittenConfig,
    });

    for (const run of [lastRun, queued, summarized, elided]) {
      expect(run.authProfileId).toBeUndefined();
      expect(run.authProfileIdSource).toBeUndefined();
      expect(run.model).toBe("claude-opus-4-6");
      expect(run.config).toBe(rewrittenConfig);
    }
    expect(queued.autoFallbackPrimaryProbe).toEqual({
      provider: "anthropic",
      model: "primary",
      fallbackProvider: "anthropic",
      fallbackModel: queued.model,
    });
    expect(newer.authProfileId).toBe("profile-b");
    expect(newer.authProfileIdSource).toBe("user");
    expect(newer.autoFallbackPrimaryProbe.fallbackAuthProfileId).toBe("profile-b");
    expect(newer.config).toBe(rewrittenConfig);
    expect(otherAgent.authProfileId).toBe("profile-a");
    expect(otherAgent.config).toBe(retainedConfig);
    expect(queue.items).toHaveLength(2);
    expect(otherAgentSource.controllerInput?.mailbox).not.toBe(queue);
    expect(otherAgentSource.controllerInput?.mailbox.items).toEqual([otherAgentSource]);
  });
});

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const runs = populateRepresentations(queue);
    queue.summaryElisions[0]!.count = 2;

    refresh(
      route("openai", "gpt-4o", {
        nextAuthProfileId: undefined,
        nextAuthProfileIdSource: undefined,
      }),
    );

    const expectedRun = {
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    };
    for (const run of runs) {
      expect(run).toEqual(expectedRun);
    }
  });

  it.each(["user", undefined] as const)("retargets model override strictness to %s", (next) => {
    const run = retarget(
      next === "user"
        ? { hasAutoFallbackProvenance: true }
        : { hasSessionModelOverride: true, modelOverrideSource: "user" },
      route("ollama", "qwen3.5:27b", { nextModelOverrideSource: next }),
    );
    expect(run).toEqual({
      ...makeRun(),
      provider: "ollama",
      model: "qwen3.5:27b",
      hasSessionModelOverride: next === "user",
      modelOverrideSource: next,
    });
  });

  it.each([
    { name: "clears", admitted: "user" as const, next: undefined },
    { name: "adopts", admitted: undefined, next: "user" as const },
    { name: "follows", admitted: "user" as const, next: "auto" as const },
  ])(
    "$name queued scheduled fallback provenance with the retargeted session selection",
    ({ admitted, next }) => {
      const automation = scheduledAutomation(admitted);
      const run = retarget(
        { scheduledAutomation: automation },
        route("openai", "gpt-4o", { nextModelOverrideSource: next }),
      );

      expect(run?.scheduledAutomation).toEqual({
        ...automation,
        modelFallbackPolicy: {
          useSubagentFallbacks: false,
          inheritDefaultFallbacksForAgentStringModel: false,
          sessionModelOverrideSource: next,
        },
      });
      expect(run?.scheduledAutomation?.job).toBe(automation.job);
      expect(automation.modelFallbackPolicy).toEqual(
        scheduledAutomation(admitted).modelFallbackPolicy,
      );
    },
  );

  it("keeps queued scheduled fallback provenance through session-only refreshes", () => {
    const automation = scheduledAutomation("user");
    const run = retarget(
      { scheduledAutomation: automation },
      { previousSessionId: "session-1", nextSessionId: "session-2" },
    );

    expect(run?.sessionId).toBe("session-2");
    expect(run?.scheduledAutomation).toBe(automation);
  });

  it.each([
    ["openai", "gpt-5.6-luna", "codex", reasoningModel("gpt-5.6-luna", "Luna")],
    ["custom", "reasoner", "openclaw", undefined],
  ] as const)(
    "preserves Ultra when retargeting to %s/%s via %s",
    (provider, model, agentRuntime, catalog) => {
      const run = retarget(
        { provider: "openai", model: "gpt-5.6-sol", thinkLevel: "ultra" },
        route(provider, model, { nextThinking: { level: "ultra", catalog, agentRuntime } }),
      );
      expect(run).toMatchObject({
        provider,
        model,
        thinkLevel: "ultra",
        thinkingCatalog: catalog,
      });
    },
  );

  it.each([
    { requested: "high", stored: "low", expected: ["high", "high", "high"] },
    { requested: "off", stored: "high", expected: ["off", "off", "off"] },
    { requested: "ultra", stored: "off", expected: ["ultra", "ultra", "ultra"] },
    { requested: "default", stored: "off", expected: ["high", "off", "low"] },
    { requested: undefined, stored: "low", expected: ["low", "low", "low"] },
  ] as const)(
    "retains requested thinking $requested across repeated queued model switches",
    ({ requested, stored, expected }) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const runs = populateRepresentations(queue, {
        config: thinkingConfig({
          models: {
            ...highModel,
            "openai/gpt-5.6-luna": modelThinking("low"),
          },
        }),
        thinkLevel: "high",
        thinkLevelOverride: requested,
      });
      for (const [index, model] of ["gpt-5.6-sol", "non-reasoner", "gpt-5.6-luna"].entries()) {
        refresh(thinkingRoute(model, stored, index !== 1));
        for (const run of runs) {
          expect(run.thinkLevel).toBe(expected[index]);
          expect(run.thinkLevelOverride).toBe(requested);
        }
      }
    },
  );

  describe.each(["default", undefined] as const)("thinking source %s", (thinkingSource) => {
    it.each([
      [
        "agent",
        thinkingConfig(
          { thinkingDefault: "off", models: highModel },
          { main: { thinkingDefault: "low" } },
        ),
        "low",
      ],
      [
        "agent model",
        thinkingConfig(
          { models: highModel },
          { main: { models: { "openai/gpt-5.6-sol": modelThinking("low") } } },
        ),
        "low",
      ],
      ["model", thinkingConfig({ thinkingDefault: "off", models: highModel }), "high"],
      ["global", thinkingConfig({ thinkingDefault: "high" }), "high"],
    ] as const)("honors the configured %s default when retargeting", (_name, config, expected) => {
      const run = retarget(
        { config, thinkLevel: "medium", thinkLevelOverride: thinkingSource },
        thinkingRoute("gpt-5.6-sol", thinkingSource === "default" ? "off" : undefined),
      );
      expect(run?.thinkLevel).toBe(expected);
    });
  });

  it.each([undefined, "default"] as const)(
    "recomputes the model default with override %s",
    (override) => {
      const run = retarget(
        { thinkLevel: "ultra", thinkingExplicit: true, thinkLevelOverride: override },
        route("openai", "gpt-5.6-sol", {
          nextThinking: {
            agentRuntime: "codex",
            level: override === "default" ? "high" : undefined,
          },
        }),
      );

      // Sol's provider default reasoning level is medium (extensions/openai
      // thinking-policy.ts); retargeting without an override adopts it.
      expect(run).toMatchObject({ thinkLevel: "medium", thinkingExplicit: false });
    },
  );
});

describe("getFollowupQueue", () => {
  it.each([
    { mode: "collect", debounceMs: -12, cap: 9.8, dropPolicy: "new" },
    { mode: "steer", cap: 0 },
  ] as const)("normalizes supplied settings and retains omitted/invalid values: %j", (settings) => {
    const queue = getFollowupQueue(QUEUE_KEY, {
      mode: "followup",
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize",
    });
    const updated = getFollowupQueue(QUEUE_KEY, settings);
    expect(updated).toBe(queue);
    expect(updated).toMatchObject(
      settings.mode === "collect"
        ? { mode: "collect", debounceMs: 0, cap: 9, dropPolicy: "new" }
        : { mode: "steer", debounceMs: 1000, cap: 20, dropPolicy: "summarize" },
    );
  });

  it("settles evicted summary sources and retains surviving delivery correlations", () => {
    const sources = Array.from({ length: 4 }, (_, index) => ({
      prompt: `queued message ${index}`,
      enqueuedAt: index,
      run: makeRun(),
      onQueueDisposition: vi.fn(),
      deliveryCorrelations: [{ begin: () => undefined }],
    }));
    for (const source of sources) {
      expect(
        enqueueFollowupRun(QUEUE_KEY, source, {
          mode: "followup",
          cap: 1,
          dropPolicy: "summarize",
        }),
      ).toBe(true);
    }
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });
    expect(sources[0]?.onQueueDisposition).toHaveBeenCalledExactlyOnceWith("queue-cap-old");
    for (const source of sources.slice(1)) {
      expect(source.onQueueDisposition).not.toHaveBeenCalled();
    }
    expect(queue.summaryElisions[0]?.sources[0]?.deliveryCorrelations).toBe(
      sources[1]?.deliveryCorrelations,
    );
  });

  it("aborts work owned by a cleared queue", () => {
    const queuedRun = makeSource();
    enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });

    expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
    clearFollowupQueue(QUEUE_KEY);
    expect(queuedRun.queueAbortSignal?.aborted).toBe(true);
  });

  it("trims overflow metadata when a live queue cap shrinks", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
    for (const [contextKey, count] of [
      ["oldest", 2],
      ["middle", 3],
      ["newest", 4],
    ] as const) {
      queue.summaryElisions.push(
        elision(
          Array.from({ length: count }, () => makeSource(makeRun(), contextKey)),
          contextKey,
        ),
      );
    }

    const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

    expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
    expect(updated.summaryElisions[0]?.sources).toHaveLength(1);
    expect(updated.summaryElisions[0]?.summaryLines).toEqual(["newest"]);
  });
});

describe("hasPendingFollowupQueueWork", () => {
  it("checks separate pending mailboxes within one physical selection", async () => {
    const keys = [QUEUE_KEY, "session-id-only-queue"];
    const selection = captureSessionTarget({
      storeScope: "/synthetic/queue-state/two-mailboxes.sqlite",
      sessionKey: QUEUE_KEY,
      aliases: keys,
      agentId: "main",
    });
    const sources = keys.map((key, index) =>
      makeSource(
        makeRun({
          sessionKey: key,
          sessionId: `independent-incarnation-${index}`,
          config: { session: { store: selection.storeScope } },
        }),
        `Pending input ${index}`,
      ),
    );
    try {
      for (const [index, source] of sources.entries()) {
        expect(
          enqueueFollowupRun(keys[index]!, source, { mode: "followup" }, "none", undefined, false),
        ).toBe(true);
      }
      const [first, second] = sources.map((source) => source.controllerInput);
      if (!first || !second) {
        throw new Error("Expected two accepted queue inputs");
      }
      expect(first.mailbox).not.toBe(second.mailbox);
      expect(hasPendingFollowupQueueWork(keys, selection)).toBe(true);
      retireSessionControllerInput(first);
      await first.settlement.promise;
      expect(hasPendingFollowupQueueWork(keys, selection)).toBe(true);
    } finally {
      const inputs = sources.flatMap((source) => source.controllerInput ?? []);
      for (const input of inputs) {
        retireSessionControllerInput(input);
      }
      await Promise.all(inputs.map((input) => input.settlement.promise));
    }
  });

  it("detects each actionable queued-work representation", async () => {
    const cases = [
      (queue: SessionControllerMailbox) => addSources(queue, makeSource()),
      (queue: SessionControllerMailbox) => claimSource(queue, makeSource()),
      (queue: SessionControllerMailbox) => {
        queue.droppedCount = 1;
      },
    ];

    for (const populate of cases) {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      populate(queue);
      expect(hasPendingFollowupQueueWork(["", ` ${QUEUE_KEY} `, QUEUE_KEY])).toBe(true);
      await clearOwnedQueues();
    }
  });

  it("ignores empty queues", () => {
    getFollowupQueue(QUEUE_KEY, { mode: "followup" });

    expect(hasPendingFollowupQueueWork([undefined, "", QUEUE_KEY])).toBe(false);
  });
});

function addSources(queue: SessionControllerMailbox, ...sources: FollowupRun[]): void {
  for (const source of sources) {
    const input = submitSessionControllerInput(queue.key, source, { mode: queue.mode });
    input.payload = "ready";
    input.phase = "waiting";
  }
}
function claimSource(queue: SessionControllerMailbox, source: FollowupRun): void {
  const input = submitSessionControllerInput(queue.key, source, { mode: queue.mode });
  const claim = tryClaimSessionControllerTask(input);
  if (!claim) {
    throw new Error("Expected isolated test input to be selected");
  }
}
