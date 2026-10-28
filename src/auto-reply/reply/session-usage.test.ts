import { existsSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as sessionActors from "../../config/sessions/session-actor.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { prepareSessionUsageUpdate } from "./session-usage.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);

describe("session actor usage accounting", () => {
  type UsageUpdate = Parameters<typeof prepareSessionUsageUpdate>[0];
  async function usageSession(seed: Partial<SessionEntry> = {}, sessionKey = "agent:main:main") {
    const root = tempDirs.make("openclaw-usage-");
    const env = { OPENCLAW_STATE_DIR: root };
    const storePath = seed.incognito
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env })
      : path.join(root, "agents", "main", "sessions", "sessions.json");
    const scope = { agentId: "main", storePath, sessionKey, ...(seed.incognito ? { env } : {}) };
    await replaceSessionEntry(scope, { sessionId: "s1", updatedAt: 1, ...seed });
    const read = () => expectDefined(loadSessionEntry(scope), "stored session");
    return {
      scope,
      update: async (update: UsageUpdate) => {
        const entry = read();
        const operation = createReplyOperation({
          sessionId: entry.sessionId,
          sessionKey,
          resetTriggered: false,
        });
        operation.setPhase("running");
        try {
          await withAgentTurnCompletion(
            {
              ...scope,
              entry,
              operation,
              publish() {},
            },
            async (completion) => {
              if (!completion) {
                throw new Error("Missing usage completion owner");
              }
              const prepared = prepareSessionUsageUpdate({ cfg: {}, ...update });
              if (prepared) {
                completion.patch((current) => ({
                  kind: "usage",
                  update: { ...prepared.update, estimatedCostUsd: prepared.estimateCost(current) },
                  updatedAt: Date.now(),
                }));
              }
            },
          );
        } finally {
          operation.complete();
          await operation.ownerSettlement;
        }
      },
      read,
    };
  }

  const priorRuntime = {
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    agentHarnessId: "openclaw",
    contextTokens: 272_000,
  };
  const committedModel = {
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    contextTokens: 1_000_000,
    contextTokensSource: "runtime",
  } satisfies Partial<SessionEntry>;
  const producingUpdate = {
    usage: { input: 120, output: 8, total: 128 },
    providerUsed: "openai",
    modelUsed: "gpt-5.6-sol",
    contextTokensUsed: 1_000_000,
    contextTokensSource: "runtime",
  } satisfies UsageUpdate;
  function pricingConfig(
    provider: string,
    id: string,
    cost: ModelDefinitionConfig["cost"],
  ): OpenClawConfig {
    return {
      models: {
        providers: {
          [provider]: {
            baseUrl: "https://fixture.invalid",
            models: [
              {
                id,
                name: id,
                cost,
                reasoning: false,
                input: ["text"],
                contextWindow: 1_000_000,
                maxTokens: 1_000,
              },
            ],
          },
        },
      },
    };
  }

  it("persists terminal usage through an actor rebase while participant writes queue", async () => {
    const session = await usageSession();
    const competingWrites: Promise<unknown>[] = [];
    const createActor = sessionActors.createSessionActor;
    vi.spyOn(sessionActors, "createSessionActor").mockImplementation((params) => {
      const actor = createActor(params);
      if (params.target.sessionKey === session.scope.sessionKey) {
        const complete = actor.completeTurn;
        vi.spyOn(actor, "completeTurn").mockImplementationOnce(async (...command) => {
          const recordParticipant = (promptedAt: number) =>
            recordSessionParticipantInWorker(session.scope, {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "gateway-client",
              },
              promptedAt,
              sessionAgentId: "main",
            });
          await recordParticipant(1);
          const pending = complete(...command);
          competingWrites.push(runOutsideStoreWriterContext(() => recordParticipant(2)));
          const outcome = await pending;
          expect(outcome).toMatchObject({
            kind: "stale-version",
            postimage: { target: actor.target },
          });
          return outcome;
        });
      }
      return actor;
    });
    try {
      await expect(session.update(producingUpdate)).resolves.toBeUndefined();
      await Promise.all(competingWrites);
      expect(session.read()).toMatchObject({ inputTokens: 120, outputTokens: 8 });
    } finally {
      await Promise.all(competingWrites);
      vi.restoreAllMocks();
    }
  });

  it("completes usage in the existing unbound memory actor", async () => {
    const session = await usageSession(
      { incognito: true },
      "agent:main:dashboard:incognito-memory-completion",
    );
    const { scope } = session;
    const database = { agentId: scope.agentId, path: scope.storePath, env: scope.env };
    const memory = expectDefined(memorySessionActorOwners.read(database), "memory session owner");
    try {
      await session.update(producingUpdate);

      expect(session.read()).toMatchObject({ incognito: true, inputTokens: 120, outputTokens: 8 });
      expect(memorySessionActorOwners.read(database)).toBe(memory);
      expect(getOpenClawAgentDatabaseIfOpen(database)).toBeUndefined();
      expect(existsSync(scope.storePath)).toBe(false);
      expect(
        existsSync(resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env: scope.env })),
      ).toBe(false);
    } finally {
      memorySessionActorOwners.closeDatabase(database);
    }
  });

  const retainedRuntime = {
    modelProvider: "google",
    model: "gemini-3-pro",
    agentHarnessId: "openclaw",
    contextTokens: 1_000_000,
    contextTokensSource: "runtime",
    cliSessionBindings: { "claude-cli": { sessionId: "existing-cli-session" } },
    cliSessionIds: { "claude-cli": "existing-cli-session" },
    claudeCliSessionId: "existing-cli-session",
  } satisfies Partial<SessionEntry>;
  const cases: Array<{
    name: string;
    seed: Partial<SessionEntry>;
    update: UsageUpdate;
    expected: Partial<SessionEntry>;
    absent?: Array<keyof SessionEntry>;
  }> = [
    {
      name: "accounts exhausted-run usage while preserving the complete runtime and native binding",
      seed: { updatedAt: 1, ...retainedRuntime },
      update: {
        usage: { input: 120, output: 8, total: 128 },
        lastCallUsage: { input: 100, output: 8, total: 108 },
        providerUsed: "claude-cli",
        modelUsed: "claude-sonnet-4-6",
        agentHarnessId: "codex",
        contextTokensUsed: 200_000,
        contextTokensSource: "runtime-configured",
        preserveRuntimeModel: true,
      },
      expected: {
        ...retainedRuntime,
        inputTokens: 120,
        outputTokens: 8,
        totalTokens: 100,
        totalTokensFresh: true,
      },
    },
    {
      name: "clears stale harness provenance when a committed run omits it",
      seed: { updatedAt: 1, ...priorRuntime },
      update: producingUpdate,
      expected: committedModel,
      absent: ["agentHarnessId"],
    },

    {
      name: "keeps ordered context separate from output-only billing usage",
      seed: {
        totalTokens: 180_000,
        totalTokensFresh: true,
        inputTokens: 5_000,
        outputTokens: 2_000,
        cacheRead: 50_000,
        contextBudgetStatus: contextBudgetStatusFixture({
          shouldCompact: true,
          route: "compact_only",
        }),
      },
      update: {
        usage: { output: 125 },
        lastCallUsage: { output: 125 },
        providerUsed: "claude-cli",
        contextTokensUsed: undefined,
        currentContextSnapshot: { tokens: 80_000 },
      },
      expected: {
        totalTokens: 80_000,
        totalTokensFresh: true,
        inputTokens: 0,
        outputTokens: 125,
        cacheRead: 0,
        contextBudgetStatus: undefined,
      },
    },
    {
      name: "clears a previous complete snapshot after an interrupted response",
      seed: {
        inputTokens: 123,
        outputTokens: 45,
        cacheRead: 12,
        estimatedCostUsd: 0.25,
        totalTokens: 135,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      update: {
        usage: { usageReport: { state: "unavailable" }, contextUsage: { state: "unavailable" } },
        currentContextSnapshot: { tokens: undefined },
      },
      expected: {
        usageReport: { state: "unavailable" },
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        estimatedCostUsd: undefined,
        totalTokens: undefined,
        totalTokensFresh: false,
        totalTokensVersion: undefined,
      },
    },
    {
      name: "persists complete zero accounting without a price over a previous snapshot",
      seed: {
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 5,
        cacheWrite: 2,
        estimatedCostUsd: 0.5,
      },
      update: { usage: { input: 0, output: 0, total: 0, usageReport: { state: "available" } } },
      expected: {
        usageReport: { state: "available" },
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      absent: ["estimatedCostUsd"],
    },
    {
      name: "persists totalTokens from promptTokens when usage is unavailable",
      seed: { inputTokens: 1_234, outputTokens: 456 },
      update: { usage: undefined, promptTokens: 39_000 },
      expected: {
        totalTokens: 39_000,
        totalTokensFresh: true,
        inputTokens: 1_234,
        outputTokens: 456,
      },
    },
    {
      name: "marks the prior total stale when last-call context is unavailable",
      seed: { totalTokens: 148_874, totalTokensFresh: true, totalTokensVersion: 1 },
      update: {
        usage: { input: 12, output: 15_104, cacheRead: 819_661, cacheWrite: 93_130 },
        lastCallUsage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          total: 927_907,
        },
      },
      expected: {
        totalTokens: 148_874,
        totalTokensFresh: false,
        totalTokensVersion: undefined,
        inputTokens: 12,
        cacheRead: 819_661,
      },
    },
    {
      name: "preserves fresh post-compaction totalTokens across model-only updates",
      seed: { totalTokens: 42_000, totalTokensFresh: true },
      update: {
        modelUsed: "claude-sonnet-4-6",
        preserveFreshTotalTokensOnStaleUsage: true,
      },
      expected: { totalTokens: 42_000, totalTokensFresh: true },
    },
  ];
  it.each(cases)("$name", async ({ seed, update, expected, absent, name }) => {
    const session = await usageSession(seed);
    await session.update({ contextTokensUsed: 200_000, ...update });
    const stored = session.read();
    for (const [field, value] of Object.entries(expected)) {
      expect(Reflect.get(stored, field), name).toEqual(value);
    }
    for (const field of absent ?? []) {
      expect(stored, name).not.toHaveProperty(field);
    }
  });
  it("accounts goal usage when fresh token snapshots are persisted", async () => {
    const session = await usageSession({
      sessionId: "s1",
      updatedAt: 1,
      goal: {
        schemaVersion: 1,
        id: "goal-1",
        objective: "ship",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokenStartFresh: false,
        tokensUsed: 0,
        tokenBudget: 20,
        continuationTurns: 0,
      },
    });

    await session.update({
      usage: { input: 100, output: 5, total: 105 },
      lastCallUsage: { input: 100, output: 5, total: 105 },
      contextTokensUsed: 200_000,
    });

    expect(session.read().goal).toMatchObject({
      tokenStart: 100,
      tokenStartFresh: true,
      tokensUsed: 0,
      status: "active",
    });

    await session.update({
      usage: { input: 125, output: 5, total: 130 },
      lastCallUsage: { input: 125, output: 5, total: 130 },
      contextTokensUsed: 200_000,
    });

    expect(session.read().goal).toMatchObject({
      tokenStart: 100,
      tokensUsed: 25,
      status: "budget_limited",
    });
  });

  it("snapshots estimatedCostUsd instead of accumulating (fixes #69347)", async () => {
    const session = await usageSession();

    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
      ...pricingConfig("openai", "gpt-5.4", {
        input: 1.25,
        output: 10,
        cacheRead: 0.125,
        cacheWrite: 0.5,
      }),
    };

    for (let commit = 0; commit < 2; commit += 1) {
      await session.update({
        cfg,
        agentDir: "/tmp/openclaw-main-agent",
        usage: { input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 200 },
        lastCallUsage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 50 },
        providerUsed: "openai",
        modelUsed: "gpt-5.4",
        contextTokensUsed: 200_000,
      });
      expect(session.read().estimatedCostUsd).toBeCloseTo(0.007725, 8);
    }
  });

  it.each([
    { total: undefined, withTokens: true },
    { total: 0.25, withTokens: false },
  ])(
    "replaces prior snapshot cost with current tiered run cost $total (tokens: $withTokens)",
    async ({ total, withTokens }) => {
      const session = await usageSession({ estimatedCostUsd: 0.5 });

      await session.update({
        cfg: pricingConfig("fixture", "tiered", {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tieredPricing: [{ input: 2, output: 0, cacheRead: 0, cacheWrite: 0, range: [200_000] }],
        }),
        usage: {
          ...(withTokens ? { input: 300_000, output: 200 } : {}),
          ...(total !== undefined ? { cost: { total } } : {}),
        },
        providerUsed: "fixture",
        modelUsed: "tiered",
      });

      const stored = expectDefined(session.read(), "stored session");
      expect(stored.inputTokens).toBe(withTokens ? 300_000 : undefined);
      expect(stored.estimatedCostUsd).toBe(total);
      if (!withTokens) {
        for (const key of ["outputTokens", "cacheRead", "cacheWrite", "totalTokens"] as const) {
          expect(stored[key]).toBeUndefined();
        }
        expect(stored.totalTokensFresh).not.toBe(true);
      }
    },
  );

  it("preserves the displayed session model when an internal announce uses fallback", async () => {
    const topicSessionKey = "agent:main:telegram:group:-1003871627242:topic:6823";
    const visibleState = {
      ...retainedRuntime,
      modelProvider: "openai",
      model: "gpt-5.5",
      contextTokens: 200_000,
      inputTokens: 1_234,
      outputTokens: 56,
      cacheRead: 7,
      cacheWrite: 8,
      totalTokens: 1_305,
      totalTokensFresh: true,
      estimatedCostUsd: 0.123,
      cliSessionBindings: {
        "claude-cli": { sessionId: "existing-cli-session", authProfileId: "anthropic:visible" },
      },
    } satisfies Partial<SessionEntry>;
    const session = await usageSession(visibleState, topicSessionKey);

    await session.update({
      preserveUserFacingSessionModelState: true,
      usage: { input: 39_908, output: 122, cacheRead: 0, cacheWrite: 0 },
      lastCallUsage: { input: 39_908, output: 122, cacheRead: 0, cacheWrite: 0 },
      providerUsed: "google",
      modelUsed: "gemini-2.5-flash",
      contextTokensUsed: 1_000_000,
    });
    await session.update({
      preserveUserFacingSessionModelState: true,
      providerUsed: "claude-cli",
      modelUsed: "claude-sonnet-4-6",
      contextTokensUsed: 900_000,
    });

    const storedEntry = session.read();
    for (const [field, value] of Object.entries(visibleState)) {
      expect(Reflect.get(storedEntry, field)).toEqual(value);
    }
  });
});
