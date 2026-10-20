import { afterEach, describe, expect, it, vi } from "vitest";
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

function populateRepresentations(queue: SessionControllerMailbox, runs: FollowupRun["run"][]) {
  queue.lastRun = runs[0];
  addSources(queue, makeSource(runs[1]!));
  queue.summarySources.push(makeSource(runs[2]!));
  queue.summaryElisions.push(elision([makeSource(runs[3]!)]));
}

function refresh(params: Omit<Parameters<typeof refreshQueuedFollowupSession>[0], "key">) {
  refreshQueuedFollowupSession({ key: QUEUE_KEY, ...params });
}

function retarget(run: Partial<FollowupRun["run"]>, params: Parameters<typeof refresh>[0]) {
  const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
  addSources(queue, makeSource(makeRun(run)));
  refresh(params);
  return queue.items[0]?.run;
}

const modelThinking = (thinking: string) => ({ params: { thinking } });
type Agents = NonNullable<FollowupRun["run"]["config"]["agents"]>;
function thinkingConfig(defaults: Agents["defaults"], entries?: Agents["entries"]) {
  return { agents: { defaults, entries } };
}
const reasoningModel = (id: string, name = id, reasoning = true) => [
  { provider: "openai", id, name, reasoning },
];

describe("clearRemovedQueuedAuthProfiles", () => {
  it("releases removed accounts in every queued source without replacing newer choices", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const lastRun = makeRun();
    const queued = makeRun();
    const summarized = makeRun();
    const elided = makeRun();
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
      expect(run.config).toBe(rewrittenConfig);
      expect(run.model).toBe("claude-opus-4-6");
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
    populateRepresentations(
      queue,
      Array.from({ length: 4 }, () => makeRun()),
    );
    queue.summaryElisions[0]!.count = 2;

    refresh({
      nextProvider: "openai",
      nextModel: "gpt-4o",
      nextRouteResolution: "resolved",
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
    });

    const expectedRun = {
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    };
    expect(queue.lastRun).toEqual(expectedRun);
    expect(queue.items[0]?.run).toEqual(expectedRun);
    expect(queue.summarySources[0]?.run).toEqual(expectedRun);
    expect(queue.summaryElisions[0]?.sources[0]?.run).toEqual(expectedRun);
  });

  it("retargets queued runs with user model override source", () => {
    const run = retarget(
      { hasAutoFallbackProvenance: true },
      {
        nextProvider: "ollama",
        nextModel: "qwen3.5:27b",
        nextRouteResolution: "resolved",
        nextModelOverrideSource: "user",
      },
    );

    expect(run).toEqual({
      ...makeRun(),
      provider: "ollama",
      model: "qwen3.5:27b",
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
    });
  });

  it("clears queued model override strictness when retargeting to the configured default", () => {
    const run = retarget(
      { hasSessionModelOverride: true, modelOverrideSource: "user" },
      {
        nextProvider: "anthropic",
        nextModel: "claude-opus-4-6",
        nextRouteResolution: "resolved",
        nextModelOverrideSource: undefined,
      },
    );

    expect(run).toMatchObject({
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
    });
  });

  it("preserves queued Sol Ultra work when switching to Codex Luna", () => {
    const run = retarget(
      { provider: "openai", model: "gpt-5.6-sol", thinkLevel: "ultra" },
      {
        nextProvider: "openai",
        nextModel: "gpt-5.6-luna",
        nextRouteResolution: "resolved",
        nextThinking: {
          level: "ultra",
          catalog: reasoningModel("gpt-5.6-luna", "Luna"),
          agentRuntime: "codex",
        },
      },
    );

    expect(run).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "ultra",
      thinkingCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true }],
    });
  });

  it("preserves harness-only Ultra when retargeting queued work", () => {
    const run = retarget(
      { thinkLevel: "ultra" },
      {
        nextProvider: "custom",
        nextModel: "reasoner",
        nextRouteResolution: "resolved",
        nextThinking: { level: "ultra", agentRuntime: "openclaw" },
      },
    );

    expect(run?.thinkLevel).toBe("ultra");
  });

  it.each([
    ["turn", "high", "off", "gpt-5.6-sol", true, "high"],
    ["turn", "off", "high", "gpt-5.6-sol", true, "off"],
    ["default", "high", "high", "gpt-5.6-sol", true, "medium"],
    [undefined, "high", "low", "gpt-5.6-sol", true, "low"],
    ["turn", "ultra", "off", "gpt-5.6-luna", true, "ultra"],
    ["turn", "high", "off", "non-reasoner", false, "high"],
  ] as const)(
    "retargets requested %s thinking %s with stored %s to %s (reasoning %s) as %s",
    (source, current, stored, model, reasoning, expected) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const runs = Array.from({ length: 4 }, () =>
        makeRun({
          thinkLevel: current,
          thinkLevelOverride: source === "turn" ? current : source,
        }),
      );
      populateRepresentations(queue, runs);
      refresh({
        nextProvider: "openai",
        nextModel: model,
        nextThinking: {
          level: stored,
          catalog: reasoningModel(model, model, reasoning),
          agentRuntime: "codex",
        },
      });
      expect(runs.map((run) => run.thinkLevel)).toEqual(Array(4).fill(expected));
      expect(runs.map((run) => run.thinkLevelOverride)).toEqual(
        Array(4).fill(source === "turn" ? current : source),
      );
    },
  );

  it.each([
    { requested: "high", stored: "low", expected: ["high", "high", "high"] },
    { requested: "off", stored: "high", expected: ["off", "off", "off"] },
    { requested: "default", stored: "off", expected: ["high", "off", "low"] },
    { requested: undefined, stored: "high", expected: ["high", "high", "high"] },
  ] as const)(
    "retains requested thinking $requested across repeated queued model switches",
    ({ requested, stored, expected }) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const run = makeRun({
        config: thinkingConfig({
          models: {
            "openai/gpt-5.6-sol": modelThinking("high"),
            "openai/gpt-5.6-luna": modelThinking("low"),
          },
        }),
        thinkLevel: "high",
        thinkLevelOverride: requested,
      });
      addSources(queue, makeSource(run));
      for (const [index, model] of ["gpt-5.6-sol", "non-reasoner", "gpt-5.6-luna"].entries()) {
        refresh({
          nextProvider: "openai",
          nextModel: model,
          nextThinking: {
            level: stored,
            catalog: reasoningModel(model, model, index !== 1),
            agentRuntime: "codex",
          },
        });
        expect(run.thinkLevel).toBe(expected[index]);
        expect(run.thinkLevelOverride).toBe(requested);
      }
    },
  );

  describe.each(["default", undefined] as const)("thinking source %s", (thinkingSource) => {
    it.each([
      [
        "agent",
        thinkingConfig(
          {
            thinkingDefault: "off",
            models: { "openai/gpt-5.6-sol": modelThinking("high") },
          },
          { main: { thinkingDefault: "low" } },
        ),
        "low",
      ],
      [
        "agent model",
        thinkingConfig(
          { models: { "openai/gpt-5.6-sol": modelThinking("high") } },
          {
            main: {
              models: { "openai/gpt-5.6-sol": modelThinking("low") },
            },
          },
        ),
        "low",
      ],
      [
        "model",
        thinkingConfig({
          thinkingDefault: "off",
          models: { "openai/gpt-5.6-sol": modelThinking("high") },
        }),
        "high",
      ],
      ["global", thinkingConfig({ thinkingDefault: "high" }), "high"],
    ] as const)("honors the configured %s default when retargeting", (_name, config, expected) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const run = makeRun({
        config,
        thinkLevel: "medium",
        thinkLevelOverride: thinkingSource,
      });
      addSources(queue, makeSource(run));
      refresh({
        nextProvider: "openai",
        nextModel: "gpt-5.6-sol",
        nextThinking: {
          level: thinkingSource === "default" ? "off" : undefined,
          catalog: reasoningModel("gpt-5.6-sol", "Sol"),
          agentRuntime: "codex",
        },
      });
      expect(run.thinkLevel).toBe(expected);
    });
  });

  it("recomputes the retargeted model default when the session has no thinking override", () => {
    const run = retarget(
      { thinkLevel: "ultra", thinkingExplicit: true },
      {
        nextProvider: "openai",
        nextModel: "gpt-5.6-sol",
        nextRouteResolution: "resolved",
        nextThinking: { agentRuntime: "codex" },
      },
    );

    // Sol's provider default reasoning level is medium (extensions/openai
    // thinking-policy.ts); retargeting without an override adopts it.
    expect(run).toMatchObject({ thinkLevel: "medium", thinkingExplicit: false });
  });
});

describe("getFollowupQueue", () => {
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
    queue.evictedSummaryCount = 5;

    const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

    expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
    expect(updated.summaryElisions[0]?.sources).toHaveLength(1);
    expect(updated.summaryElisions[0]?.summaryLines).toEqual(["newest"]);
    expect(updated.evictedSummaryCount).toBe(13);
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
    const pending = keys.map((key, index) => ({
      key,
      source: makeSource(
        makeRun({
          sessionKey: key,
          sessionId: `independent-incarnation-${index}`,
          config: { session: { store: selection.storeScope } },
        }),
        `Pending input ${index}`,
      ),
    }));
    const sources: FollowupRun[] = pending.map(({ source }) => source);
    try {
      for (const { key, source } of pending) {
        expect(
          enqueueFollowupRun(key, source, { mode: "followup" }, "none", undefined, false),
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
      for (const source of sources) {
        if (source.controllerInput) {
          retireSessionControllerInput(source.controllerInput);
        }
      }
      await Promise.all(
        sources.flatMap((source) =>
          source.controllerInput ? [source.controllerInput.settlement.promise] : [],
        ),
      );
    }
  });

  it("detects each actionable queued-work representation", async () => {
    const cases = [
      (queue: ReturnType<typeof getFollowupQueue>) => {
        addSources(queue, makeSource());
      },
      (queue: ReturnType<typeof getFollowupQueue>) => {
        claimSource(queue, makeSource(makeRun(), "in-flight collected message"));
      },
      (queue: ReturnType<typeof getFollowupQueue>) => {
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

  it("ignores empty queues and historical eviction accounting", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.evictedSummaryCount = 3;

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
