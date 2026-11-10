import { afterEach, expect, it } from "vitest";
import { modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import { captureRuntimeConfigWithSource } from "../../config/runtime-config-capture-state.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  captureSessionEventConfigRelevance,
  captureSessionEventConfigPolicy,
} from "./session-event-policy.js";
import { getSessionEventRuntimeConfig } from "./session-event-target.js";

afterEach(() => clearRuntimeConfigSnapshot());

it.each([
  ["another agent's entry", { other: {} }, true],
  ["its own agent's entry", { main: { tools: { deny: ["exec"] } } }, false],
] satisfies Array<[string, NonNullable<OpenClawConfig["agents"]>["entries"], boolean]>)(
  "keeps an unscheduled event across a publication of %s",
  (_change, entries, retained) => {
    const before: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    setRuntimeConfigSnapshot(before);
    const policy = captureSessionEventConfigPolicy(getSessionEventRuntimeConfig(), "main");
    setRuntimeConfigSnapshot({
      ...before,
      agents: { ...before.agents, entries: { ...before.agents?.entries, ...entries } },
    });
    const check = () => policy.assertCurrent(getSessionEventRuntimeConfig(), ["telegram"]);
    if (retained) {
      expect(check).not.toThrow();
    } else {
      expect(check).toThrow("Session event configuration changed");
    }
  },
);

it.each([
  ["another agent's", "other", true],
  ["its own agent's", "main", false],
] as const)("keeps an unscheduled event across %s env secret reference", (_owner, id, retained) => {
  const before: OpenClawConfig = { agents: { entries: { main: {}, other: {} } } };
  const after = structuredClone(before);
  setConfigResolutionFacts(before, createConfigResolutionFacts([]));
  setConfigResolutionFacts(
    after,
    createConfigResolutionFacts(
      [],
      new Map([[`agents.entries.${id}.tts.providers.voice.apiKey`, "SYNTHETIC_TTS_KEY"]]),
    ),
  );
  const check = captureSessionEventConfigRelevance(
    captureRuntimeConfigWithSource(before, before),
    "main",
    undefined,
  );
  expect(check(captureRuntimeConfigWithSource(after, after), [])).toBe(retained);
});

it.each([
  ["openclaw", false, true],
  ["openclaw", true, false],
  ["codex", false, false],
  [undefined, undefined, false],
] as const)(
  "delegates MCP authority only to its owning runtime: %s/%s",
  (agentRuntime, cliExecution, retained) => {
    const config = (command: string): OpenClawConfig => ({
      mcp: { servers: { sentry: { command } } },
    });
    const before = config("before");
    const after = config("after");
    setConfigResolutionFacts(before, createConfigResolutionFacts([]));
    setConfigResolutionFacts(
      after,
      createConfigResolutionFacts(
        [],
        new Map([["mcp.servers.sentry.env.TOKEN", "SYNTHETIC_MCP_TOKEN"]]),
      ),
    );
    for (const job of [undefined, makeCronJob({})]) {
      const policy = captureSessionEventConfigPolicy(
        captureRuntimeConfigWithSource(before, config("${BEFORE_COMMAND}")),
        "main",
        job,
      );
      policy.selectModel({ provider: "openai", model: "model", agentRuntime, cliExecution });
      const check = () =>
        policy.assertCurrent(captureRuntimeConfigWithSource(after, config("${AFTER_COMMAND}")), []);
      if (retained) {
        expect(check).not.toThrow();
      } else {
        expect(check).toThrow("Session event configuration changed");
      }
    }
  },
);

it.each([
  ["profile binding", false],
  ["provider alias", false],
  ["model endpoint alias", false],
  ["provider endpoint", false],
  ["auth alias endpoint", false],
  ["auth source expression", false],
  ["unrelated source expression", true],
] as const)("keeps the captured %s authority", (scenario, retained) => {
  const sourceExpression = scenario.includes("source expression");
  const endpoint = "https://upstream.example.test/v1";
  const config: OpenClawConfig = {
    auth: { profiles: { "upstream:manual": { provider: "upstream", mode: "api_key" } } },
    models: {
      providers: {
        route: {
          baseUrl: scenario === "model endpoint alias" ? "https://route.example.test/v1" : endpoint,
          ...(scenario === "profile binding" ? { apiKey: "upstream:manual" } : {}),
          models: [modelDefinition("model", { baseUrl: endpoint })],
        },
        upstream: { baseUrl: endpoint, models: [] },
      },
    },
  };
  const authored = (name: string) => ({
    ...config,
    auth: {
      profiles: {
        "upstream:manual": {
          provider: sourceExpression ? `\${${name}}` : "upstream",
          mode: "api_key" as const,
        },
      },
    },
  });
  const captured = captureRuntimeConfigWithSource(config, authored("AUTH_REALM"));
  let next = sourceExpression
    ? captureRuntimeConfigWithSource(config, authored("NEXT_REALM"))
    : captureRuntimeConfigWithSource(
        {
          ...config,
          auth: { profiles: { "upstream:manual": { provider: "upstream", mode: "token" } } },
        },
        {
          ...config,
          auth: { profiles: { "upstream:manual": { provider: "upstream", mode: "token" } } },
        },
      );
  if (scenario.endsWith("endpoint")) {
    const provider = scenario === "provider endpoint" ? "route" : "upstream";
    next = {
      ...config,
      models: {
        providers: {
          ...config.models?.providers,
          [provider]: { baseUrl: "https://changed.example.test/v1", models: [] },
        },
      },
    };
  }
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "upstream",
        providerAuthAliases:
          scenario === "provider alias" || scenario === "auth alias endpoint"
            ? { route: "upstream" }
            : scenario === "model endpoint alias"
              ? { route: { provider: "upstream", baseUrls: [endpoint] } }
              : {},
      },
    ],
  });
  withPluginMetadataSnapshotScope(
    metadata,
    () => {
      for (const job of [undefined, makeCronJob({})]) {
        const policy = captureSessionEventConfigPolicy(captured, "main", job);
        policy.selectModel({
          provider: scenario === "auth source expression" ? "upstream" : "route",
          model: "model",
        });
        const check = () => policy.assertCurrent(next, []);
        if (retained) {
          expect(check).not.toThrow();
        } else {
          expect(check).toThrow("Session event configuration changed");
        }
      }
    },
    { config: captured, trustConfigIdentity: true },
  );
});

it.for([
  [
    "auth profile",
    (provider: string): OpenClawConfig => ({
      auth: { profiles: { added: { provider, mode: "api_key" } } },
    }),
  ],
  [
    "auth order",
    (provider: string): OpenClawConfig => ({ auth: { order: { [provider]: ["manual"] } } }),
  ],
  [
    "model provider",
    (provider: string): OpenClawConfig => ({
      models: {
        providers: { [provider]: { baseUrl: "https://model.example.test/v1", models: [] } },
      },
    }),
  ],
] as const)("narrows unscheduled %s publications only after selection", ([, config]) => {
  for (const selected of [false, true]) {
    for (const provider of ["selected", "unrelated"]) {
      const policy = captureSessionEventConfigPolicy({}, "main");
      if (selected) {
        policy.selectModel({ provider: "selected", model: "model" });
      }
      const check = () => policy.assertCurrent(config(provider), []);
      if (selected && provider === "unrelated") {
        expect(check).not.toThrow();
      } else {
        expect(check).toThrow("Session event configuration changed");
      }
    }
  }
});

it.for([
  [
    "allowlist extension",
    { agents: { defaults: { modelPolicy: { allow: ["selected/model", "other/model"] } } } },
    true,
  ],
  [
    "allowlist removal",
    { agents: { defaults: { modelPolicy: { allow: ["other/model"] } } } },
    false,
  ],
  ["own entry", { agents: { entries: { main: { tools: { deny: ["write"] } } } } }, false],
  ["defaults", { agents: { defaults: { workspace: "/different-workspace" } } }, false],
  ["shared tools", { tools: { deny: ["write"] } }, false],
  ["route channel", { channels: { telegram: { enabled: false } } }, false],
] satisfies Array<[string, OpenClawConfig, boolean]>)(
  "keeps selected unscheduled policy for %s",
  ([, after, retained]) => {
    const policy = captureSessionEventConfigPolicy({}, "main");
    policy.selectModel({ provider: "selected", model: "model" });
    const check = () => policy.assertCurrent(after, ["telegram"]);
    if (retained) {
      expect(check).not.toThrow();
    } else {
      expect(check).toThrow("Session event configuration changed");
    }
  },
);

it("rechecks fallback auth against the original unscheduled capture after an accepted publication", () => {
  const config: OpenClawConfig = {};
  setRuntimeConfigSnapshot(config);
  const policy = captureSessionEventConfigPolicy(config, "main");
  policy.selectModel({ provider: "first", model: "model" });
  // The live origin can be republished in place; neither selection may recapture it.
  config.auth = { profiles: { fallback: { provider: "fallback", mode: "api_key" } } };
  setRuntimeConfigSnapshot(config);
  expect(() => policy.assertCurrent(config, [])).not.toThrow();
  policy.selectModel({ provider: "fallback", model: "model" });
  expect(() => policy.assertCurrent(config, [])).toThrow("Session event configuration changed");
});
