import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { modelDefinition, providerEntry } from "../agents/model-auth.fixtures.test-support.js";
import type { loadManifestModelCatalog } from "../agents/model-catalog.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { readSessionStore, writeSessionStoreSeed } from "./agent-session.test-support.js";
import { agentCommand } from "./agent.js";

/** Registers agent-command cases for model overrides already saved on a session. */
export function registerAgentStoredOverrideTests({
  withTempHome,
  mockConfig,
  mockModelCatalogOnce,
  expectLastRunProviderModel,
  expectModelAttempts,
  runtime,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (
    home: string,
    storePath: string,
    agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  ) => OpenClawConfig;
  mockModelCatalogOnce: (entries: ReturnType<typeof loadManifestModelCatalog>) => void;
  expectLastRunProviderModel: (provider: string, model: string) => void;
  expectModelAttempts: (expected: Array<{ provider: string; model: string }>) => void;
  runtime: RuntimeEnv;
}) {
  const runCommand = (opts: Omit<Parameters<typeof agentCommand>[0], "message">) =>
    agentCommand({ message: "hi", ...opts }, runtime);

  type StoredModelCase = {
    name: string;
    source?: "auto" | "user";
    provider?: string;
    model?: string;
    origin?: boolean;
    locked?: boolean;
    disallowed?: boolean;
    oneoff?: boolean;
    failure?: string;
    fallback?: boolean;
    expected?: string[];
    clear?: Array<keyof SessionEntry>;
  };
  it.for<StoredModelCase>([
    {
      name: "origin-backed auto fallback",
      source: "auto",
      origin: true,
      failure: "rate limited",
      fallback: true,
      expected: ["openai/gpt-4.1-mini", "openai/gpt-5.4"],
    },
    {
      name: "locked auto override",
      source: "auto",
      origin: true,
      locked: true,
      failure: "rate limited",
      expected: ["anthropic/claude-opus-4-6"],
    },
    {
      name: "legacy auto override",
      source: "auto",
      expected: ["openai/gpt-4.1-mini"],
      clear: ["providerOverride", "modelOverride", "modelOverrideSource"],
    },
    {
      name: "user override without fallback",
      source: "user",
      provider: "ollama",
      model: "qwen3.5:27b",
      failure: "connect ECONNREFUSED",
      expected: ["ollama/qwen3.5:27b"],
    },
    {
      name: "disallowed override cleanup",
      disallowed: true,
      expected: ["openai/gpt-4.1-mini"],
      clear: [
        "providerOverride",
        "modelOverride",
        "authProfileOverride",
        "authProfileOverrideSource",
        "authProfileOverrideCompactionCount",
        "fallbackNotice",
      ],
    },
    {
      name: "locked disallowed override",
      source: "user",
      locked: true,
      disallowed: true,
      expected: ["anthropic/claude-opus-4-6"],
    },
    { name: "locked one-off rejection", source: "user", locked: true, oneoff: true },
  ])("respects stored model policy: $name", async (scenario) => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:model-policy";
      const sessionId = "model-policy-session";
      const provider = scenario.provider ?? "anthropic";
      const model = scenario.model ?? "claude-opus-4-6";
      const storedRef = `${provider}/${model}`;
      const primary = "openai/gpt-4.1-mini";
      const fallback = "openai/gpt-5.4";
      const cleanup = scenario.disallowed && !scenario.locked;
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId,
          providerOverride: provider,
          modelOverride: model,
          ...(scenario.source && { modelOverrideSource: scenario.source }),
          ...(scenario.locked && { modelSelectionLocked: true }),
          ...(scenario.origin && {
            modelOverrideFallbackOriginProvider: "openai",
            modelOverrideFallbackOriginModel: "gpt-4.1-mini",
          }),
          ...(cleanup && {
            authProfileOverride: "profile-legacy",
            authProfileOverrideSource: "user",
            authProfileOverrideCompactionCount: 2,
            fallbackNotice: {
              kind: "active",
              selectedModel: storedRef,
              activeModel: primary,
              reason: "fallback",
            },
          }),
        },
      });
      const refs = cleanup
        ? [primary]
        : scenario.disallowed || scenario.oneoff
          ? [storedRef, primary]
          : [storedRef, primary, fallback];
      mockConfig(home, store, {
        model: {
          primary: scenario.oneoff ? storedRef : primary,
          ...((!scenario.oneoff && !scenario.locked) || scenario.origin
            ? { fallbacks: [cleanup ? storedRef : fallback] }
            : {}),
        },
        models: Object.fromEntries(refs.map((ref) => [ref, {}])),
        ...(scenario.disallowed && { modelPolicy: { allow: [primary] } }),
      });
      if (!scenario.oneoff) {
        mockModelCatalogOnce([
          { provider, id: model, name: provider === "ollama" ? "Qwen 3.5" : "Opus" },
          { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
          ...(!scenario.disallowed
            ? [
                {
                  provider: "openai",
                  id: "gpt-5.4",
                  name: scenario.fallback ? "GPT-5.2" : "GPT-5.4",
                },
              ]
            : []),
        ]);
      }
      if (scenario.failure) {
        vi.mocked(runEmbeddedAgent).mockRejectedValueOnce(
          Object.assign(
            new Error(scenario.failure),
            scenario.failure === "rate limited" ? { status: 429 } : {},
          ),
        );
      }
      if (scenario.fallback) {
        vi.mocked(runEmbeddedAgent).mockResolvedValueOnce({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 5, agentMeta: { sessionId, provider: "openai", model: "gpt-5.4" } },
        });
      }
      const command = runCommand({
        sessionKey,
        ...(scenario.oneoff && { model: primary, allowModelOverride: true }),
      });
      if (scenario.oneoff) {
        await expect(command).rejects.toMatchObject({
          name: "ModelSelectionLockedError",
          message: MODEL_SELECTION_LOCKED_MESSAGE,
        });
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        return;
      }
      if (scenario.failure && !scenario.fallback) {
        await expect(command).rejects.toThrow(scenario.failure);
      } else {
        await command;
      }
      expectModelAttempts(
        (scenario.expected ?? []).map((ref) => {
          const [expectedProvider, expectedModel] = ref.split("/");
          return {
            provider: expectDefined(expectedProvider, "expected provider"),
            model: expectDefined(expectedModel, "expected model"),
          };
        }),
      );
      const entry = readSessionStore<SessionEntry>(store)[sessionKey];
      for (const field of scenario.clear ?? []) {
        expect(entry?.[field]).toBeUndefined();
      }
      if (scenario.disallowed && scenario.locked) {
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
        expectLastRunProviderModel(provider, model);
        expect(entry).toMatchObject({
          providerOverride: provider,
          modelOverride: model,
          modelOverrideSource: "user",
          modelSelectionLocked: true,
        });
      } else if (cleanup) {
        expectLastRunProviderModel("openai", "gpt-4.1-mini");
      }
    });
  });

  it("keeps a configured direct pick next to a wrapped default in models replace mode", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:replace-mode-override";
      const userPick = {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-5-5",
        modelOverrideSource: "user" as const,
        modelOverrideRouteResolution: "resolved" as const,
      };
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId: "replace-mode-override", ...userPick },
      });
      // Replace mode supplies no plugin catalog; both routes exist only as configured models.
      const cfg = mockConfig(home, store, {
        model: { primary: "clawrouter/anthropic/claude-opus-5-5" },
      });
      cfg.models = {
        mode: "replace",
        providers: {
          anthropic: providerEntry("http://127.0.0.1:1", {
            models: [modelDefinition("claude-opus-5-5")],
          }),
          clawrouter: providerEntry("http://127.0.0.1:1", {
            models: [modelDefinition("anthropic/claude-opus-5-5")],
          }),
        },
      };

      await runCommand({ sessionKey });

      expectLastRunProviderModel("anthropic", "claude-opus-5-5");
      expect(readSessionStore<SessionEntry>(store)[sessionKey]).toMatchObject(userPick);
    });
  });

  it.each([
    {
      name: "keeps a cataloged direct pick",
      wrapper: "clawrouter",
      cataloged: true,
      provider: "anthropic",
      model: "claude-opus-5-5",
    },
    {
      name: "repairs an uncataloged split wrapper",
      wrapper: "openrouter",
      cataloged: false,
      provider: "openrouter",
      model: "anthropic/claude-opus-5-5",
    },
  ])("loads a pre-upgrade wrapped-looking user override: $name", async (scenario) => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:pre-upgrade-override";
      // Entry shape written by v2026.10.6 for a user pick next to a wrapped default.
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "pre-upgrade-override",
          providerOverride: "anthropic",
          modelOverride: "claude-opus-5-5",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      });
      mockConfig(home, store, {
        model: { primary: `${scenario.wrapper}/anthropic/claude-opus-5-5` },
      });
      mockModelCatalogOnce([
        { provider: scenario.wrapper, id: "anthropic/claude-opus-5-5", name: "Opus" },
        ...(scenario.cataloged
          ? [{ provider: "anthropic", id: "claude-opus-5-5", name: "Opus" }]
          : []),
      ]);

      await runCommand({ sessionKey });

      expectLastRunProviderModel(scenario.provider, scenario.model);
      const entry = readSessionStore<SessionEntry>(store)[sessionKey];
      if (scenario.cataloged) {
        expect(entry).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-opus-5-5",
          modelOverrideSource: "user",
        });
      } else {
        expect(entry?.providerOverride).toBeUndefined();
        expect(entry?.modelOverride).toBeUndefined();
      }
    });
  });
}
