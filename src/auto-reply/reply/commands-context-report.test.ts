/** Tests context command behavior, token reporting, and generated report files. */
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import type { SessionCostSummary } from "../../infra/session-cost-usage.types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { buildContextReply } from "./commands-context-report.js";
import { buildCommandContextForTest as buildCommandContext } from "./commands-context.test-support.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import type * as CostRuntime from "./commands-session-cost.runtime.js";
import { loadCurrentSessionCostSummary } from "./commands-session-cost.runtime.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { stripStructuralPrefixes } from "./mentions.js";
import { buildTestCtx } from "./test-ctx.js";

// The `/usage cost` reader has its own suite; here the card only formats what it returns.
vi.mock("./commands-session-cost.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CostRuntime>()),
  loadCurrentSessionCostSummary: vi.fn<typeof CostRuntime.loadCurrentSessionCostSummary>(
    async () => null,
  ),
}));

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: {
    omitBootstrapLimits?: boolean;
    contextTokens?: number | null;
    totalTokens?: number | null;
    totalTokensFresh?: boolean;
    cfg?: Record<string, unknown>;
    sessionKey?: string;
    sessionId?: string;
    storePath?: string;
    agentId?: string;
    currentTurn?: NonNullable<SessionEntry["systemPromptReport"]>["currentTurn"];
    nativeUnverified?: boolean;
    estimated?: boolean;
    layeredAgents?: boolean;
  },
): HandleCommandsParams {
  const totalTokensFresh = options?.totalTokensFresh ?? true;
  return {
    ...commandFixture(commandBodyNormalized),
    command: { commandBodyNormalized, channel: "forum", senderIsOwner: true },
    sessionKey: options?.sessionKey ?? "agent:default:main",
    contextTokens: options?.contextTokens ?? null,
    storePath: options?.storePath,
    provider: "ollama",
    model: "qwen2.5:7b",
    thinkingCatalog:
      options?.contextTokens != null
        ? [{ provider: "ollama", id: "qwen2.5:7b", contextWindow: options.contextTokens }]
        : [],
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    sessionEntry: {
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      totalTokens: options?.totalTokens ?? 123,
      totalTokensFresh,
      ...(totalTokensFresh ? { totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION } : {}),
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        source: options?.estimated ? "estimate" : "run",
        generatedAt: Date.now(),
        workspaceDir: "/tmp/workspace",
        bootstrapMaxChars: options?.omitBootstrapLimits ? undefined : 12_000,
        bootstrapTotalMaxChars: options?.omitBootstrapLimits ? undefined : 60_000,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: { chars: 1_000, projectContextChars: 500, nonProjectContextChars: 500 },
        ...(options?.currentTurn ? { currentTurn: options.currentTurn } : {}),
        injectedWorkspaceFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/workspace/AGENTS.md",
            missing: false,
            rawChars: truncated && !options?.nativeUnverified ? 200_000 : 10_000,
            injectionStatus: options?.nativeUnverified ? "native_unverified" : undefined,
            injectedChars: options?.nativeUnverified ? null : truncated ? 12_000 : 10_000,
            truncated: options?.nativeUnverified ? null : truncated,
          },
          ...(options?.layeredAgents
            ? [
                {
                  name: "AGENTS.md",
                  path: "/tmp/workspace/main/AGENTS.md",
                  missing: false,
                  rawChars: 3_000,
                  injectedChars: 3_000,
                  truncated: false,
                },
              ]
            : []),
        ],
        skills: { promptChars: 10, entries: [{ name: "checks", blockChars: 10 }] },
        tools: {
          listChars: 10,
          schemaChars: 20,
          entries: [{ name: "read", summaryChars: 10, schemaChars: 20, propertiesCount: 1 }],
        },
      },
    },
    cfg: options?.cfg ?? {},
    agentId: options?.agentId,
  } as unknown as HandleCommandsParams;
}

function detailParams(options: Parameters<typeof makeParams>[2] = {}) {
  return makeParams("/context detail", false, {
    contextTokens: 8_192,
    totalTokens: 900,
    ...options,
  });
}

function toolExchange(timestamp: number) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", toolName: "read", toolCallId: "call-1", args: {} }],
      timestamp,
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: "package.json" }],
      timestamp: timestamp + 1,
      toolCallId: "call-1",
      toolName: "read",
    },
  ];
}

async function contextMap(options: NonNullable<Parameters<typeof makeParams>[2]>) {
  const result = await buildContextReply(
    makeParams("/context map", false, { contextTokens: 8_192, totalTokens: 900, ...options }),
  );
  if (!result.mediaUrl) {
    throw new Error("missing context map media path");
  }
  const mediaUrl = result.mediaUrl;
  onTestFinished(() => unlink(mediaUrl));
  return { ...result, mediaUrl };
}

function commandContext(body: string, overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  return buildCommandContext({
    ctx: buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "user",
      To: "bot",
      Body: body,
      RawBody: body,
      CommandBody: body,
      BodyForCommands: body,
      ...overrides,
    }),
    cfg: {},
    isGroup: false,
    triggerBodyNormalized: stripStructuralPrefixes(body),
    commandAuthorized: true,
  });
}

async function withTranscript(
  messages: unknown[],
  run: (target: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => Promise<void>,
  options: { agentId?: string; sessionKey?: string } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-context-report-"));
  setRuntimeConfigSnapshot({});
  const agentId = options.agentId ?? "default";
  const target = {
    agentId,
    sessionId: "session",
    sessionKey: options.sessionKey ?? `agent:${agentId}:main`,
    storePath: join(dir, "sessions.json"),
  };
  const incognito = isIncognitoSessionKey(target.sessionKey);
  const storePath = resolveSessionStorePathForScope(target);
  try {
    await persistSessionTranscriptTurn(
      { ...target, storePath },
      {
        initialSessionEntry: incognito
          ? { sessionId: target.sessionId, updatedAt: 1, incognito: true }
          : undefined,
        messages: messages.map((message, index) => ({
          eventId: `record-${index + 1}`,
          message,
          parentId: index === 0 ? null : `record-${index}`,
        })),
        touchSessionEntry: false,
      },
    );
    await run(target);
  } finally {
    if (incognito) {
      memorySessionActorOwners.closeDatabase({ agentId, path: storePath });
    }
    closeOpenClawAgentDatabasesForTest();
    await rm(dir, { recursive: true, force: true });
    clearRuntimeConfigSnapshot();
  }
}

describe("buildContextReply", () => {
  it.each([
    [undefined, undefined, undefined, 32_768],
    [65_536, undefined, undefined, 65_536],
    [200_000, undefined, undefined, 200_000],
    [undefined, 16_384, undefined, 16_384],
    [undefined, undefined, "other-runtime", null],
  ] as const)(
    "projects session window (resolved=%s authored=%s harness=%s)",
    async (resolved, authored, persistedHarness, expected) => {
      const params = makeParams("/context json", false, { contextTokens: 200_000 });
      const model = expectDefined(params.model, "context fixture model");
      params.sessionEntry = {
        ...params.sessionEntry,
        sessionId: "local-context",
        updatedAt: 1,
        modelProvider: params.provider,
        model: params.model,
        agentHarnessId: persistedHarness ?? "openclaw",
        contextTokens: 32_768,
        contextTokensSource: "resolved-v1",
      };
      params.thinkingCatalog = [{ provider: params.provider, id: model, contextWindow: resolved }];
      if (authored !== undefined) {
        params.cfg = {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                models: [
                  {
                    id: model,
                    name: "Qwen 2.5 7B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 131_072,
                    contextTokens: authored,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        };
      }

      const result = await buildContextReply(params);
      expect(JSON.parse(result.text ?? "{}").session.contextTokens).toBe(expected);
    },
  );

  it("describes compactable chat history counts in help output", async () => {
    const result = await buildContextReply(makeParams("/context help", false));
    expect(result.text).toContain(
      "/context detail (per-file + per-tool + per-skill + system prompt size + compactable chat history counts)",
    );
  });

  it("shows the prompt budget card for bare /context", async () => {
    const result = await buildContextReply(
      makeParams("/context", false, { contextTokens: 8_192, totalTokens: 4_000 }),
    );
    expect(result.text).toBe(
      [
        "🧠 Prompt budget · 4k / 8.2k · 49%",
        "🟦🟦🟦🟦🟦🟦🟦🟦🟧🟧🟧🟧🟧🟩🟨⬜⬜⬜⬜⬜",
        "",
        "🟦 Messages & other · ~3.7k",
        "🟧 Workspace files · ~2.5k",
        "🟩 Tool schemas · ~8",
        "🟨 Skills catalog · ~3",
        "🟪 System instructions · ~0",
        "",
        "More: /context list · /context detail · /context map · /context json",
      ].join("\n"),
    );
  });

  it("measures the card against the last run's validated prompt budget, like the Control UI", async () => {
    const usage = { input: 100, output: 5, cacheRead: 900, cacheWrite: 0, totalTokens: 1_005 };
    await withTranscript(
      [
        { role: "user", content: "hi", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "a" }], usage, timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "b" }], usage, timestamp: 3 },
      ],
      async (target) => {
        const params = makeParams("/context", false, {
          contextTokens: 8_192,
          totalTokens: 4_000,
          ...target,
        });
        const status: NonNullable<SessionEntry["contextBudgetStatus"]> = {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: Date.now(),
          provider: "ollama",
          model: "qwen2.5:7b",
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 4_000,
          contextTokenBudget: 8_192,
          promptBudgetBeforeReserve: 5_000,
          reserveTokens: 3_192,
          effectiveReserveTokens: 3_192,
          remainingPromptBudgetTokens: 1_000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 2,
          unwindowedMessageCount: 2,
        };
        const entry = expectDefined(params.sessionEntry, "session entry");

        entry.contextBudgetStatus = { ...status, sessionId: target.sessionId };
        const lines = (await buildContextReply(params)).text?.split("\n");
        expect(lines?.[0]).toBe("🧠 Prompt budget · 4k / 5k · 80%");
        // Read from the stored transcript: both calls of the latest run count.
        expect(lines).toContain("Latest run: 90.00% cache");
        // A budget recorded for another model is not this session's limit.
        entry.contextBudgetStatus = { ...status, sessionId: target.sessionId, model: "other" };
        expect((await buildContextReply(params)).text?.split("\n")[0]).toBe(
          "🧠 Prompt budget · 4k / 8.2k · 49%",
        );
      },
    );
  });

  it("shows latest-run and whole-session cache and cost like the Control UI", async () => {
    const usage = (overrides: Partial<SessionCostSummary>): SessionCostSummary => ({
      input: 500,
      output: 0,
      cacheRead: 9_000,
      cacheWrite: 500,
      totalTokens: 10_000,
      totalCost: 154.52,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
      cacheUnmeasuredInput: 0,
      ...overrides,
    });
    // The latest run made two measured calls and one without cache telemetry: the rate
    // sums the measured calls (90%) instead of aggregate input over the last call's reads.
    const call = (callUsage: Record<string, unknown>) => ({
      role: "assistant",
      content: [],
      usage: callUsage,
    });
    const recentMessages = [
      { role: "user", content: "older" },
      call({ input: 1_000, cacheRead: 0, cacheWrite: 0 }),
      { role: "user", content: "latest" },
      call({ input: 100, cacheRead: 900, cacheWrite: 0 }),
      call({ input: 500, cacheRead: 0, cacheTelemetry: { state: "unavailable" } }),
      call({ input: 100, cacheRead: 900, cacheWrite: 0 }),
    ];
    await withTranscript(recentMessages, async (target) => {
      const params = makeParams("/context", false, {
        contextTokens: 8_192,
        totalTokens: 4_000,
        ...target,
      });
      expectDefined(params.sessionEntry, "session entry").estimatedCostUsd = 0.306;
      const lines = async (sessionUsage: SessionCostSummary | null) => {
        vi.mocked(loadCurrentSessionCostSummary).mockResolvedValueOnce(sessionUsage);
        const result = await buildContextReply(params);
        return (result.text ?? "")
          .split("\n")
          .filter((line) => /^(Latest run|Session total):/.test(line));
      };

      expect(await lines(usage({}))).toEqual([
        "Latest run: 90.00% cache · $0.31",
        "Session total: 90.00% cache · $154.52",
      ]);
      // A partly priced total is a lower bound; usage without any price is never $0.
      expect((await lines(usage({ missingCostEntries: 2 })))[1]).toBe(
        "Session total: 90.00% cache · ≥ $154.52",
      );
      expect((await lines(usage({ totalCost: 0, missingCostEntries: 3 })))[1]).toBe(
        "Session total: 90.00% cache · unpriced",
      );
      // Calls without a cache split are left out of the rate, not counted as misses.
      expect((await lines(usage({ input: 10_500, cacheUnmeasuredInput: 10_000 })))[1]).toBe(
        "Session total: 90.00% cache · $154.52",
      );
      expect(await lines(null)).toEqual(["Latest run: 90.00% cache · $0.31"]);
    });
  });

  it("keeps the budget bar at 20 cells when small categories take their minimum cell", async () => {
    const result = await buildContextReply(
      makeParams("/context", false, { contextTokens: 100_000, totalTokens: 99_000 }),
    );
    const bar = result.text?.split("\n")[1];
    expect(bar).toMatch(/^(?:🟦|🟧|🟩|🟨|🟪|⬜){20}$/u);
  });

  it("does not invent a message share when cached usage is stale", async () => {
    const result = await buildContextReply(
      makeParams("/context", false, { contextTokens: 8_192, totalTokensFresh: false }),
    );
    expect(result.text?.split("\n")[0]).toBe("🧠 Prompt budget · ? / 8.2k");
    expect(result.text).toContain("🟦 Messages & other · unknown");
  });

  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 60,000 chars");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
    expect(result.text).toContain("agents.entries.*.bootstrapMaxChars");
    expect(result.text).toContain("agents.defaults.*");
  });

  it("reports native Codex project docs as unverified without OpenClaw limit advice", async () => {
    const params = makeParams("/context detail", false, { nativeUnverified: true });
    // Codex base instructions taken from configuration rather than the loaded thread.
    params.sessionEntry!.systemPromptReport!.systemPrompt.estimatedChars = 400;
    const result = await buildContextReply(params);

    expect(result.text).toContain("(Project Context 500 chars (~125 tok); estimated 400 chars");
    expect(result.text).toContain(
      "- AGENTS.md: NATIVE/UNVERIFIED | raw(local) 10,000 chars (~2,500 tok) | injected unknown",
    );
    expect(result.text).toContain("one aggregate root-to-CWD byte budget");
    expect(result.text).toContain("later AGENTS.md files can be partial");
    expect(result.text).toContain("read the relevant scoped file directly");
    expect(result.text).not.toContain("Bootstrap context is over configured limits");
    expect(result.text).not.toContain("agents.entries.*.bootstrapMaxChars");
  });

  it("names the source path when two injected files share a basename", async () => {
    const result = await buildContextReply(
      makeParams("/context detail", false, { layeredAgents: true }),
    );

    expect(result.text).toContain(
      "- AGENTS.md (/tmp/workspace/AGENTS.md): OK | raw 10,000 chars (~2,500 tok) | injected 10,000 chars (~2,500 tok)",
    );
    expect(result.text).toContain(
      "- AGENTS.md (/tmp/workspace/main/AGENTS.md): OK | raw 3,000 chars (~750 tok) | injected 3,000 chars (~750 tok)",
    );
  });

  it("tells same-named files apart on context map tiles", async () => {
    // Moving a file changes only its path, so the image can change only through its tile label.
    // Real workspace paths are longer than a tile, so the distinguishing directory must survive clipping.
    const root = "/home/operator/.openclaw/workspace-root";
    const image = async (layeredAgents: boolean, movedPath: string) => {
      const params = makeParams("/context map", false, { layeredAgents });
      const moved = params.sessionEntry?.systemPromptReport?.injectedWorkspaceFiles.at(-1);
      if (!moved) {
        throw new Error("missing injected workspace file");
      }
      moved.path = movedPath;
      const { mediaUrl } = await buildContextReply(params);
      if (!mediaUrl) {
        throw new Error("missing context map media path");
      }
      onTestFinished(() => unlink(mediaUrl));
      return readFile(mediaUrl);
    };

    const shared = await image(true, `${root}/main/AGENTS.md`);
    expect(shared.equals(await image(true, `${root}/other/AGENTS.md`))).toBe(false);
    const unique = await image(false, `${root}/main/AGENTS.md`);
    expect(unique.equals(await image(false, `${root}/other/AGENTS.md`))).toBe(true);
  });

  it("uses the session agent profile when legacy reports are missing bootstrap limits", async () => {
    const result = await buildContextReply(
      makeParams("/context list", false, {
        omitBootstrapLimits: true,
        sessionKey: "agent:scout:main",
        cfg: {
          agents: {
            entries: { scout: { bootstrapMaxChars: 32_000, bootstrapTotalMaxChars: 96_000 } },
          },
        },
      }),
    );
    expect(result.text).toContain("Bootstrap max/file: 32,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 96,000 chars");
  });

  it.each([true, false])("counts compactable anchors (paged/incognito=%s)", async (paged) => {
    const messages = paged
      ? [
          ...Array.from({ length: 127 }, (_, timestamp) => ({
            role: "assistant",
            content: "NO_REPLY",
            timestamp,
          })),
          { role: "user", content: "Please inspect the repo", timestamp: 1 },
          ...toolExchange(2),
        ]
      : toolExchange(1);
    await withTranscript(
      messages,
      async (target) => {
        const { text } = await buildContextReply(detailParams(target));
        expect(text).toContain(
          `Compactable chat history: ${paged ? 2 : 0} real conversation message(s) / ${paged ? 130 : 2} history entries`,
        );
        if (paged) {
          expect(text).not.toContain("Compaction note:");
        } else {
          expect(text).toContain(
            "Compaction note: prompt/cache usage may be high even when there are no compactable conversation messages.",
          );
        }
      },
      paged
        ? {
            agentId: "context-incognito",
            sessionKey: "agent:context-incognito:dashboard:incognito-context-report",
          }
        : {},
    );
  });

  it("shows estimate-only detail output when cached context usage is unavailable", async () => {
    const result = await buildContextReply(detailParams({ totalTokensFresh: false }));
    expect(result.text).toContain("Tracked prompt estimate: 1,020 chars (~255 tok)");
    expect(result.text).toContain("Actual context usage (cached): unavailable");
    expect(result.text).toContain("Session tokens (cached): unknown / ctx=8,192");
    expect(result.text).not.toContain("~645 tok");
  });

  it("prefers the target session entry from sessionStore for cached context stats", async () => {
    await withTranscript([{ role: "user", content: "cached context fixture" }], async (target) => {
      const params = detailParams({ ...target, totalTokens: 111 });
      const sessionEntry = {
        ...params.sessionEntry,
        sessionId: target.sessionId,
        updatedAt: params.sessionEntry?.updatedAt ?? 1,
        outputTokens: 11,
      } satisfies SessionEntry;
      params.sessionEntry = sessionEntry;
      params.sessionStore = {
        [params.sessionKey]: {
          ...sessionEntry,
          totalTokens: 900,
          inputTokens: 700,
          outputTokens: 200,
        },
      };

      const result = await buildContextReply(params);

      expect(result.text).toContain("Actual context usage (cached): 900 tok");
      expect(result.text).toContain("Session tokens (cached): 900 total / ctx=8,192");
      expect(result.text).not.toContain("Actual context usage (cached): 111 tok");
    });
  });

  it("omits unknown native project-document bytes from context maps", async () => {
    expect((await contextMap({ nativeUnverified: true })).text).toContain("Tracked: 1,020 chars");
  });

  it("includes transcript conversation size in context maps", async () => {
    await withTranscript(
      [
        { role: "user", content: "abcd", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "efghij" }], timestamp: 2 },
        {
          role: "toolResult",
          content: [{ type: "text", text: "klmno" }],
          timestamp: 3,
          toolCallId: "call-1",
          toolName: "read",
        },
      ],
      async (target) => {
        const result = await contextMap(target);
        const png = await readFile(result.mediaUrl);
        expect(result.text).toContain("Conversation: 20 chars (~5 tok)");
        expect(result).toMatchObject({ trustedLocalMedia: true, sensitiveMedia: true });
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      },
    );
  });

  it("counts model-only turn context but not the persisted current-turn prompt", async () => {
    const result = await contextMap({
      currentTurn: {
        kind: "room_event",
        promptChars: 11,
        runtimeContextChars: 17,
        modelOnlyPromptChars: 5,
      },
    });
    expect(result.text).toContain("Tracked: 10,542 chars");
    expect(result.text).toContain("Conversation: 22 chars (~6 tok)");
  });

  it("does not render context map from an estimated report", async () => {
    const params = makeParams("/context map", false, { estimated: true });
    const result = await buildContextReply(params);

    expect(result.text).toContain("Context treemap unavailable.");
    expect(result.text).toContain("No actual run context is cached for this session yet.");
    expect(result.text).not.toContain("Source: estimate");
    expect(result.mediaUrl).toBeUndefined();
  });
});

describe("buildCommandContext", () => {
  it("maps explicit gateway origin into command context", () => {
    const result = commandContext("/codex bind", {
      Provider: "internal",
      Surface: "internal",
      OriginatingChannel: "slack",
      OriginatingTo: "user:U123",
      SenderId: "gateway-client",
      From: undefined,
      To: undefined,
    });

    expect(result).toMatchObject({
      channel: "slack",
      channelId: "slack",
      from: "gateway-client",
      to: "user:U123",
    });
  });
});
