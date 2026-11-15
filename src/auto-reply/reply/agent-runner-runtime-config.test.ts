import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";

function makeRun(config: OpenClawConfig): FollowupRun["run"] {
  return createQueueTestRun(
    { prompt: "test" },
    {
      config,
      sessionKey: "agent:test:session",
      skipProviderRuntimeHints: true,
      thinkingCatalog: [
        {
          provider: "openai",
          id: "gpt-4.1-mini",
          input: ["text"],
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    },
  ).run;
}

function resolveRun(run: FollowupRun["run"]) {
  return buildEmbeddedRunExecutionParams({
    run,
    provider: "openai",
    model: "gpt-4.1-mini",
    runId: "run-1",
    sessionCtx: {},
    hasRepliedRef: undefined,
  });
}

function providerConfig(
  apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
): OpenClawConfig {
  return {
    models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey, models: [] } } },
  };
}

afterEach(clearRuntimeConfigSnapshot);

it("keeps an already-resolved run config instead of reverting to a stale runtime snapshot", async () => {
  const staleSnapshot = providerConfig({
    source: "env",
    provider: "default",
    id: "OPENAI_API_KEY",
  });
  const resolvedRunConfig = providerConfig("resolved-runtime-key");
  setRuntimeConfigSnapshot(staleSnapshot, staleSnapshot);

  const resolved = await resolveRun(makeRun(resolvedRunConfig));

  expect(resolved.config).toBe(resolvedRunConfig);
});

it("carries out-of-band tool bindings into the embedded run", async () => {
  const run = makeRun({});
  run.toolBindings = { browser: { kind: "tab", targetId: "target-1" } };

  const resolved = await resolveRun(run);

  expect(resolved.toolBindings).toEqual(run.toolBindings);
});
