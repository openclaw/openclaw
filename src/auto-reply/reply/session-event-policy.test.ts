import { expect, it } from "vitest";
import { modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import { captureRuntimeConfigWithSource } from "../../config/runtime-config-capture-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { captureScheduledSessionEventConfigPolicy } from "./session-event-policy.js";

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
      const check = captureScheduledSessionEventConfigPolicy(captured, "main", makeCronJob({}), {
        provider: scenario === "auth source expression" ? "upstream" : "route",
        model: "model",
      });
      expect(check(next, [])).toBe(retained);
    },
    { config: captured, trustConfigIdentity: true },
  );
});
