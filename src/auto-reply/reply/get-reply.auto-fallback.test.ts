import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveModelRefFromString } from "../../agents/model-selection-shared.js";
import { makeConfiguredModel } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
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

function reply(cfg = makeReasoningModelConfig(), opts?: Parameters<typeof getReplyFromConfig>[1]) {
  return getReplyFromConfig(fixtures.buildGetReplyCtx(), opts, cfg);
}

async function expectRun(
  cfg: OpenClawConfig,
  expected: object,
  opts?: Parameters<typeof reply>[1],
) {
  await expect(reply(cfg, opts)).resolves.toEqual({ text: "ok" });
  expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject(expected);
}

function makeReasoningModelConfig(
  agents: NonNullable<OpenClawConfig["agents"]> = {},
): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      ...agents,
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
        ...agents.defaults,
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeConfiguredModel({ id: "gpt-5.5", name: "GPT-5.5", maxTokens: 8192 })],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [
            makeConfiguredModel({
              id: "claude-fallback",
              name: "Claude Fallback",
              reasoning: false,
              maxTokens: 8192,
            }),
          ],
        },
      },
    },
  } satisfies OpenClawConfig);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function setupFallback(resolvedReasoningLevel?: "off" | "on") {
  const sessionKey = "agent:main:telegram:123";
  const sessionEntry: SessionEntry = {
    sessionId: "fallback-session",
    updatedAt: Date.now(),
    providerOverride: "anthropic",
    modelOverride: "claude-fallback",
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "openai",
    modelOverrideFallbackOriginModel: "gpt-5.5",
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
      provider: "anthropic",
      model: "claude-fallback",
      resolvedReasoningLevel,
    }),
  );
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

  it.each<{
    source: string;
    agents?: NonNullable<OpenClawConfig["agents"]>;
    override?: string;
    thinking: "off" | "medium";
  }>([
    { source: "turn", override: "off", thinking: "off" },
    { source: "invalid turn", override: "not-a-level", thinking: "medium" },
    { source: "agent", agents: { entries: { main: { thinkingDefault: "off" } } }, thinking: "off" },
    {
      source: "model",
      agents: { defaults: { models: { "openai/gpt-5.5": { params: { thinking: false } } } } },
      thinking: "off",
    },
  ])(
    "resolves $source thinking defaults and clears fallback reasoning",
    async ({ source, agents, override, thinking }) => {
      setupFallback(source === "model" ? "on" : source === "agent" ? "off" : undefined);
      await expectRun(
        makeReasoningModelConfig(agents),
        {
          provider: "openai",
          model: "gpt-5.5",
          resolvedThinkLevel: thinking,
          resolvedReasoningLevel: "off",
        },
        { thinkingLevelOverride: override },
      );
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
    await expectRun(cfg, {
      modelState: { provider: "anthropic", model: "claude-fallback" },
      provider: "openai",
      model: "gpt-5.5",
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
  });
});
