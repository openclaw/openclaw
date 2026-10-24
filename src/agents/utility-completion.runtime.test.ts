import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { FailoverError, recordModelFallbackStop } from "./failover-error.js";
import * as modelAuth from "./model-auth.js";
import "./model-fallback-runner.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";
import {
  prepareUtilityCompletionForAgent,
  resolveUtilityCompletionRuntimeForAgent,
  runUtilityCompletion,
  type UtilityCompletionRuntimeParams,
} from "./utility-completion.js";

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function config(defaults: Defaults, models?: OpenClawConfig["models"]): OpenClawConfig {
  return { agents: { defaults }, ...(models ? { models } : {}) };
}

function prepared(runtimeId?: string): UtilityCompletionRuntimeParams {
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.cliBackends.push({
    pluginId: "anthropic",
    source: "runtime",
    backend: {
      id: "claude-cli",
      modelProvider: "anthropic",
      config: { command: "claude" },
    },
  });
  return {
    cfg: config(
      {
        model: { primary: "anthropic/claude-opus-4-6" },
        utilityModel: "anthropic/claude-haiku-4-5",
        ...(runtimeId
          ? { models: { "anthropic/claude-haiku-4-5": { agentRuntime: { id: runtimeId } } } }
          : {}),
      },
      {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            apiKey: "synthetic-key",
            models: [],
          },
        },
      },
    ),
    agentId: "main",
    pluginRegistry,
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          providers: ["anthropic"],
          cliBackends: ["claude-cli"],
          providerAuthAliases: { "claude-cli": "anthropic" },
        },
      ],
    }),
    preparedAuthStore: { version: 1, profiles: {} },
    preparedRuntimeAuthModes: { "claude-cli": "oauth" },
    snapshot: {
      entries: [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" }],
      routeVariants: [],
    },
  };
}

it.each([
  ["claude-cli", { id: "claude-cli", kind: "cli", label: "Claude CLI" }],
  [undefined, { id: "openclaw", kind: "api", label: "OpenClaw Default" }],
] as const)("reports the selected owner for pin %s", async (pin, expected) => {
  await expect(resolveUtilityCompletionRuntimeForAgent(prepared(pin))).resolves.toEqual(expected);
});

it.each([true, false])(
  "reports a plugin harness only when it supports isolated completions (%s)",
  async (isolated) => {
    const params = prepared("route-test");
    params.pluginRegistry!.agentHarnesses.push({
      pluginId: "route-test",
      source: "runtime",
      harness: {
        id: "route-test",
        label: "Route Test",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        ...(isolated ? { runIsolatedCompletionV2: vi.fn() } : {}),
      },
    });
    await expect(resolveUtilityCompletionRuntimeForAgent(params)).resolves.toEqual(
      isolated ? { id: "route-test", kind: "harness", label: "Route Test" } : undefined,
    );
  },
);

it.each(["missing credentials", "retired owner"])("omits a route with %s", async (reason) => {
  const params = prepared();
  if (reason === "missing credentials") {
    params.cfg.models = undefined;
  } else {
    params.isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  }
  await withEnvAsync(
    { ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined },
    async () => {
      await expect(resolveUtilityCompletionRuntimeForAgent(params)).resolves.toBeUndefined();
    },
  );
});

it.each([false, true])(
  "keeps the primary runtime regardless of prepared API credentials (%s)",
  async (hasApiCredential) => {
    const params = prepared();
    params.cfg.models = undefined;
    params.cfg.agents!.defaults!.utilityModel = undefined;
    params.cfg.agents!.defaults!.models = {
      "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
    };
    const plugin = params.metadataSnapshot.plugins[0];
    if (!plugin) {
      throw new Error("Expected the Anthropic metadata fixture.");
    }
    plugin.modelCatalog = {
      providers: {
        anthropic: {
          defaultUtilityModel: "claude-haiku-4-5",
          models: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-4-6" }],
        },
      },
    };
    if (hasApiCredential) {
      params.preparedAuthStore.profiles["anthropic:test"] = {
        type: "api_key",
        provider: "anthropic",
        key: "synthetic-prepared-key",
      };
    }
    using credentialLookup = vi.spyOn(modelAuth, "hasAvailableAuthForProvider");
    const runtime = await resolveUtilityCompletionRuntimeForAgent(params);
    expect(runtime).toEqual({ id: "claude-cli", kind: "cli", label: "Claude CLI" });
    expect(credentialLookup).not.toHaveBeenCalled();
  },
);

const complete = vi.fn();
const cfg = config({
  model: { primary: "main/large", fallbacks: ["main/expensive"] },
  utilityModel: { primary: "local/small@local:utility", fallbacks: ["backup", "other/last"] },
  models: { "other/backup": { alias: "backup" } },
});
const answer = {
  text: "Generated utility answer",
  provider: "other",
  model: "backup",
  owner: { kind: "harness", id: "openclaw" },
};
type Request = Parameters<typeof runUtilityCompletion>[0];
const request = async (overrides: Partial<Request> = {}): Promise<Request> => ({
  ...(await prepareUtilityCompletionForAgent({
    cfg,
    agentId: "main",
    useUtilityModel: "required",
  })),
  prompt: "Synthetic task",
  systemPrompt: "Return a short result.",
  timeoutMs: 1000,
  ...overrides,
});
const run = async (overrides: Partial<Request> = {}) =>
  runUtilityCompletion(await request(overrides), complete);
const failThenAnswer = (reason: "timeout" | "rate_limit" = "timeout") => {
  complete
    .mockRejectedValueOnce(new FailoverError("Provider unavailable", { reason }))
    .mockResolvedValue(answer);
};
beforeEach(() => {
  complete.mockReset();
});

it("resolves fallback aliases and keeps credentials and main-model fallbacks independent", async () => {
  failThenAnswer();
  await expect(run()).resolves.toEqual(answer);
  expect(
    complete.mock.calls.map(([call]) => [call.provider, call.model, call.authProfileId]),
  ).toEqual([
    ["local", "small", "local:utility"],
    ["other", "backup", undefined],
  ]);
});

it("preserves operator model restrictions for utility fallbacks", async () => {
  failThenAnswer("rate_limit");
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "fixture",
    scopes: ["operator.write"],
    assertCurrent() {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { allow: ["local/*", "other/*"], deny: ["other/backup"] },
      manifestPlugins: [],
    }),
  });
  await run({ operatorAuthority: authority });
  expect(complete.mock.calls.map(([call]) => `${call.provider}/${call.model}`)).toEqual([
    "local/small",
    "other/last",
  ]);
});

it("reads current fallbacks when reusing a prepared primary and retains its credential owner", async () => {
  failThenAnswer();
  await run({
    config: config({
      ...cfg.agents?.defaults,
      utilityModel: { primary: "local/small@local:utility", fallbacks: ["local/backup"] },
    }),
  });
  expect(complete.mock.calls.map(([call]) => [call.model, call.authProfileId])).toEqual([
    ["small", "local:utility"],
    ["backup", "local:utility"],
  ]);
});

it("does not replay a terminal provider failure", async () => {
  const error = new Error("Terminal provider failure");
  recordModelFallbackStop(error);
  complete.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(complete).toHaveBeenCalledOnce();
});

it("honors cancellation before another utility candidate", async () => {
  const controller = new AbortController();
  complete.mockImplementationOnce(() => {
    controller.abort(new Error("Caller cancelled"));
    throw new FailoverError("Connection refused", { reason: "timeout" });
  });
  await expect(run({ abortSignal: controller.signal })).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});
