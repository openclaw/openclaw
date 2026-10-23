import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveModelRefFromString } from "../../agents/model-selection-shared.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { ThinkLevel } from "../thinking.js";
import { emptyAliasIndex, withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import * as fixtures from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
}));

fixtures.registerGetReplyRuntimeOverrides(mocks);

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
    authoritative: true,
  })),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;
let resolveModelRefFromStringMock: typeof import("../../agents/model-selection.js").resolveModelRefFromString;

function makeTestModel(id: string, name: string, reasoning: boolean): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function reply(cfg = makeReasoningModelConfig(), opts?: Parameters<typeof getReplyFromConfig>[1]) {
  return getReplyFromConfig(fixtures.buildGetReplyCtx(), opts, cfg);
}

function expectRun(expected: object) {
  expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
  expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject(expected);
}

function makeReasoningModelConfig(
  agents: NonNullable<OpenClawConfig["agents"]> = {},
): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
        ...agents.defaults,
      },
      ...("entries" in agents ? { entries: agents.entries } : {}),
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function setupFallback(
  params: {
    modelSelectionLocked?: boolean;
    resolvedReasoningLevel?: "off" | "on";
    provider?: string;
    model?: string;
  } = {},
) {
  const sessionKey = "agent:main:telegram:123";
  const sessionEntry: SessionEntry = {
    sessionId: "fallback-session",
    updatedAt: Date.now(),
    providerOverride: "anthropic",
    modelOverride: "claude-fallback",
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "openai",
    modelOverrideFallbackOriginModel: "gpt-5.5",
    modelSelectionLocked: params.modelSelectionLocked,
  };
  // Admission re-reads SQLite; seed the same session the mocks describe.
  const storePath = path.join(tempDirs.make("auto-fallback-store"), "sessions.json");
  replaceSessionEntrySync({ storePath, sessionKey }, sessionEntry);
  mocks.initSessionState.mockResolvedValue(
    fixtures.createGetReplySessionState({
      sessionKey,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      storePath,
      triggerBodyNormalized: "hello",
      bodyStripped: "hello",
    }),
  );
  mocks.resolveReplyDirectives.mockImplementation(async () =>
    fixtures.createGetReplyContinueDirectivesResult({
      body: "hello",
      abortKey: sessionKey,
      from: "telegram:user:42",
      to: "telegram:123",
      senderId: "telegram:user:42",
      commandSource: "text",
      senderIsOwner: true,
      resetHookTriggered: false,
      provider: params.provider ?? "anthropic",
      model: params.model ?? "claude-fallback",
      resolvedReasoningLevel: params.resolvedReasoningLevel,
    }),
  );
  return { sessionKey, storePath };
}

async function expectPrimaryProbe(
  cfg: OpenClawConfig,
  thinking: ThinkLevel,
  opts?: Parameters<typeof getReplyFromConfig>[1],
) {
  await expect(reply(cfg, opts)).resolves.toEqual({ text: "ok" });
  expectRun({
    provider: "openai",
    model: "gpt-5.5",
    resolvedThinkLevel: thinking,
    resolvedReasoningLevel: "off",
  });
}

describe("getReplyFromConfig auto-fallback primary probes", () => {
  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
    ({ resolveDefaultModel: resolveDefaultModelMock } =
      await import("./directive-handling.defaults.js"));
    ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
    ({ resolveModelRefFromString: resolveModelRefFromStringMock } =
      await import("../../agents/model-selection.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENCLAW_TEST_FAST;
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    vi.mocked(resolveModelRefFromStringMock).mockImplementation(resolveModelRefFromString);

    vi.mocked(resolveDefaultModelMock).mockReset().mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });
    mocks.handleInlineActions.mockImplementation(async (params: unknown) => ({
      kind: "continue",
      directives: (params as { directives?: unknown }).directives ?? {},
      cleanedBody: (params as { cleanedBody?: string }).cleanedBody ?? "hello",
      abortedLastRun: false,
    }));
    vi.mocked(runPreparedReplyMock).mockReset().mockResolvedValue({ text: "ok" });
  });

  it("does not start a primary probe after cancellation while its thinking catalog is pending", async () => {
    setupFallback();
    const catalog = createDeferred<never[]>();
    const started = createDeferred();
    const catalogRuntime = await import("../../agents/model-catalog.runtime.js");
    vi.mocked(catalogRuntime.loadProviderScopedThinkingCatalog).mockImplementationOnce(() => {
      started.resolve();
      return catalog.promise;
    });
    const controller = new AbortController();
    const cfg = makeReasoningModelConfig();
    delete cfg.models;
    const pending = reply(cfg, { abortSignal: controller.signal });
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("reply finished without awaiting thinking catalog discovery");
      }),
    ]);
    controller.abort(new Error("reply deadline"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    catalog.resolve([]);
    await catalog.promise;
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it.each([
    { override: "off", thinking: "off" },
    { override: "not-a-level", thinking: "medium" },
  ] as const)(
    "resolves thinking override $override to $thinking on primary probes",
    async ({ override, thinking }) => {
      setupFallback();
      await expectPrimaryProbe(makeReasoningModelConfig(), thinking, {
        thinkingLevelOverride: override,
      });
    },
  );

  it("uses the policy-selected model defaults when the primary probe is filtered out", async () => {
    setupFallback();
    const cfg = makeReasoningModelConfig({
      defaults: {
        models: { "openai/gpt-5.5": { params: { thinking: "high" } } },
        modelPolicy: { allow: ["anthropic/*"] },
      },
    });
    const catalogRuntime = await import("../../agents/model-catalog.runtime.js");
    const catalog = [
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
      { provider: "anthropic", id: "claude-fallback", name: "Claude Fallback", reasoning: false },
    ];
    vi.mocked(catalogRuntime.loadPreparedModelCatalogSnapshot).mockResolvedValueOnce({
      entries: catalog,
      routeVariants: catalog,
      authoritative: true,
    });
    await expect(reply(cfg)).resolves.toEqual({ text: "ok" });
    expectRun({
      modelState: { provider: "anthropic", model: "claude-fallback" },
      provider: "openai",
      model: "gpt-5.5",
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
  });

  it.each(["agent", "model"] as const)(
    "honors per-%s thinking-off defaults and clears fallback reasoning",
    async (source) => {
      setupFallback({ resolvedReasoningLevel: source === "model" ? "on" : "off" });
      const agents: NonNullable<OpenClawConfig["agents"]> =
        source === "agent"
          ? { entries: { main: { thinkingDefault: "off" } } }
          : { defaults: { models: { "openai/gpt-5.5": { params: { thinking: false } } } } };
      await expectPrimaryProbe(makeReasoningModelConfig(agents), "off");
    },
  );
});
