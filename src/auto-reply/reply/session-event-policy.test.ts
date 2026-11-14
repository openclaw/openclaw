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
  ["another agent's entry", { other: {} }, undefined, true],
  ["its own agent's tools", { main: { tools: { deny: ["exec"] } } }, undefined, false],
  ["its own agent's avatar", { main: { identity: { avatar: "avatar.png" } } }, undefined, true],
  ["another agent's secret reference", {}, "other.tts.providers.voice.apiKey", true],
  ["its own agent's secret reference", {}, "main.tts.providers.voice.apiKey", false],
  ["its own agent's identity reference", {}, "main.identity.avatar", true],
] satisfies Array<
  [string, NonNullable<OpenClawConfig["agents"]>["entries"], string | undefined, boolean]
>)("keeps session events across a publication of %s", (_change, entries, factPath, retained) => {
  const before: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  const after = {
    agents: { ...before.agents, entries: { ...before.agents?.entries, ...entries } },
  };
  const path = `agents.entries.${factPath}`;
  setConfigResolutionFacts(before, createConfigResolutionFacts([]));
  setConfigResolutionFacts(
    after,
    createConfigResolutionFacts(
      factPath ? [{ varName: "SYNTHETIC_KEY", configPath: path }] : [],
      new Map(factPath ? [[path, "SYNTHETIC_KEY"]] : []),
    ),
  );
  for (const job of [makeCronJob({}), undefined]) {
    setRuntimeConfigSnapshot(before);
    const policy = captureSessionEventConfigPolicy(getSessionEventRuntimeConfig(), "main", job);
    setRuntimeConfigSnapshot(after);
    const check = () => policy.assertCurrent(getSessionEventRuntimeConfig(), ["telegram"]);
    if (retained) {
      expect(check).not.toThrow();
    } else {
      expect(check).toThrow("Session event configuration changed");
    }
  }
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
    const check = captureSessionEventConfigRelevance(
      captureRuntimeConfigWithSource(before, config("${BEFORE_COMMAND}")),
      "main",
      makeCronJob({}),
      { provider: "openai", model: "model", agentRuntime, cliExecution },
    );
    expect(check(captureRuntimeConfigWithSource(after, config("${AFTER_COMMAND}")), [])).toBe(
      retained,
    );
  },
);

it.each([
  ["enablement", { advisor: { enabled: true } }],
  ["settings", { advisor: { enabled: true, config: { everyMinutes: 5 } } }],
  ["secret reference", { advisor: { enabled: true, config: { token: "${ADVISOR_TOKEN}" } } }],
] as const)("leaves plugin %s changes to the plugin reload owner", (_scenario, entries) => {
  const before: OpenClawConfig = { plugins: { entries: { advisor: { enabled: false } } } };
  const after: OpenClawConfig = { plugins: { entries } };
  setConfigResolutionFacts(before, createConfigResolutionFacts([]));
  setConfigResolutionFacts(
    after,
    createConfigResolutionFacts(
      [{ varName: "ADVISOR_TOKEN", configPath: "plugins.entries.advisor.config.token" }],
      new Map([["plugins.entries.advisor.config.token", "ADVISOR_TOKEN"]]),
    ),
  );
  // Scheduled and unscheduled session events share this relevance check.
  for (const job of [makeCronJob({}), undefined]) {
    const check = captureSessionEventConfigRelevance(
      captureRuntimeConfigWithSource(before, before),
      "main",
      job,
    );
    expect(check(captureRuntimeConfigWithSource(after, after), [])).toBe(true);
    // Policy outside the plugin owner still revokes the occurrence.
    expect(
      check(captureRuntimeConfigWithSource({ ...after, tools: { deny: ["exec"] } }, after), []),
    ).toBe(false);
  }
});

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
      const check = captureSessionEventConfigRelevance(captured, "main", makeCronJob({}), {
        provider: scenario === "auth source expression" ? "upstream" : "route",
        model: "model",
      });
      expect(check(next, [])).toBe(retained);
    },
    { config: captured, trustConfigIdentity: true },
  );
});
