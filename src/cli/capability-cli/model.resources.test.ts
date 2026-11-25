import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { resolveProviderConfigSecretInput } from "../../agents/model-auth-provider-config.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import * as completion from "../../agents/simple-completion-execution.js";
import {
  completionChunk,
  completionConfig,
  completionModelDefinition,
  startCompletionServer,
} from "../../agents/simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { defaultRuntime } from "../../runtime.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../secrets/sentinel.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as cliUtils from "../cli-utils.js";
import { registerModelCapabilityCommands } from "./model.js";
import * as shared from "./shared.js";

const CONFIG_ENV = "OPENCLAW_TEST_PROVENANCE_CONFIG_KEY";
const ACCOUNT_ENV = "OPENCLAW_TEST_PROVENANCE_ACCOUNT_KEY";
const MISSING_ENV = "OPENCLAW_TEST_PROVENANCE_MISSING_KEY";
const configRef = { source: "env" as const, provider: "default", id: CONFIG_ENV };
// A config secret matching a profile ID must remain secret bytes, not a profile selector.
const CONFIG_KEY = "customcfg:decoy"; // pragma: allowlist secret
const ACCOUNT_KEY = "synthetic-account-key"; // pragma: allowlist secret
const output = vi.fn();
const errors = vi.fn();
let state: OpenClawTestState;
let parent: AsyncWorkScope;

beforeEach(async () => {
  state = await createOpenClawTestState({
    env: {
      [CONFIG_ENV]: CONFIG_KEY,
      [ACCOUNT_ENV]: ACCOUNT_KEY,
      [MISSING_ENV]: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.4.25",
    },
  });
  state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("bundled");
  state.applyEnv();
  parent = new AsyncWorkScope();
  output.mockClear();
  errors.mockClear();
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(output);
  vi.spyOn(defaultRuntime, "error").mockImplementation(errors);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw new Error("CLI failed");
  });
});

afterEach(async () => {
  await parent.drain();
  vi.restoreAllMocks();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearSecretsRuntimeSnapshotState();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  await state.cleanup();
});

function runModel(...options: string[]) {
  const command = new Command();
  registerModelCapabilityCommands(command);
  return command.parseAsync(["model", "run", "--prompt", "hello", "--json", ...options], {
    from: "user",
  });
}

function accountProfile(provider = "customacct", id = ACCOUNT_ENV) {
  return {
    type: "api_key" as const,
    provider,
    keyRef: { source: "env" as const, provider: "default", id },
  };
}

it.each(["config", "account", "unavailable sibling", "unavailable selected"] as const)(
  "preserves local model credential provenance: %s",
  async (scenario) => {
    const agentDir = state.agentDir("ops");
    const provider = {
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:1/v1",
      models: [completionModelDefinition({ id: "test-model", name: "Test model", maxTokens: 128 })],
    };
    const cfg = completionConfig(
      "customcfg",
      {
        ...structuredClone(provider),
        auth: "api-key",
        apiKey: configRef,
      },
      {
        agents: {
          defaults: { workspace: path.join(agentDir, "workspace") },
          entries: { ops: { agentDir, model: "customcfg/test-model" } },
        },
      },
    );
    cfg.models!.providers!.customacct = structuredClone(provider);
    setRuntimeConfigSnapshot(structuredClone(cfg), structuredClone(cfg));
    vi.spyOn(cliUtils, "runCommandWithRuntime").mockImplementation(async (_runtime, run) => run());
    const complete = vi
      .spyOn(completion, "completeWithPreparedSimpleCompletionModel")
      .mockResolvedValue(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "synthetic-ok" }],
        }),
      );
    const unavailable = scenario === "unavailable selected";
    const profiles: AuthProfileStore["profiles"] = {
      "customacct:healthy": accountProfile("customacct", unavailable ? MISSING_ENV : ACCOUNT_ENV),
    };
    if (scenario === "unavailable sibling") {
      profiles["otherprovider:cold"] = accountProfile("otherprovider", MISSING_ENV);
    } else if (!unavailable) {
      profiles["customcfg:decoy"] = {
        type: "api_key",
        provider: "customcfg",
        key: "synthetic-decoy-key", // pragma: allowlist secret
      };
    }
    await state.writeAuthProfiles({ version: 1, profiles }, "ops");
    const fromConfig = scenario === "config";
    const modelRef = `${fromConfig ? "customcfg" : "customacct"}/test-model`;
    const run = parent.track(() => runModel("--agent", "ops", "--model", modelRef, "--local"));
    if (unavailable) {
      await expect(run).rejects.toThrow(
        /Auth lookup failed for provider "customacct": .*customacct:healthy.*is configured but unavailable \(secret reference was not found\)/,
      );
      expect(complete).not.toHaveBeenCalled();
      return;
    }
    await run;
    const auth = complete.mock.calls[0]![0].auth;
    expect(auth.source).toBe(
      fromConfig ? "models.providers.customcfg" : "profile:customacct:healthy",
    );
    expect(looksLikeSecretSentinel(auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(auth.apiKey ?? "")).toBe(fromConfig ? CONFIG_KEY : ACCOUNT_KEY);
    if (fromConfig) {
      const source = getRuntimeConfigSourceSnapshot() ?? undefined;
      expect(resolveProviderConfigSecretInput(source, "customcfg").ref).toMatchObject(configRef);
    }
  },
);

it.each(["overlap", "provider-error", "callback-drain", "cancel-drain"] as const)(
  "retains local CLI completion resources through %s",
  async (mode) => {
    const root = state.root;
    fs.mkdirSync(path.join(root, "provider"));
    const fixture = createColdPluginFixture({ rootDir: path.join(root, "provider") });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "CLI fixture", auth: [] });
      } };`,
    );
    const requests: ServerResponse[] = [];
    const arrivals = [createDeferred(), createDeferred(), createDeferred()];
    let finishing = false;
    const finish = (response: ServerResponse, index: number) => {
      if (response.writableEnded || response.destroyed) {
        return;
      }
      if (!response.headersSent) {
        response.writeHead(200, { "content-type": "text/event-stream" });
      }
      response.end(completionChunk(`reply-${index}`, "cli-model"));
    };
    await using server = await startCompletionServer((request, response) => {
      request.resume();
      const index = requests.push(response) - 1;
      arrivals[index]?.resolve();
      if (finishing) {
        finish(response, index);
      }
    });
    const cfg = completionConfig(
      fixture.providerId,
      {
        api: "openai-completions",
        apiKey: "synthetic-cli-key",
        baseUrl: server.baseUrl,
        models: [completionModelDefinition({ id: "cli-model", name: "CLI model" })],
      },
      {
        agents: { defaults: { workspace: root, model: `${fixture.providerId}/cli-model` } },
        plugins: {
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      },
    );
    vi.spyOn(shared, "resolveLocalCapabilityRuntimeConfig").mockResolvedValue(cfg);
    const builds = vi.spyOn(ModelRegistry, "fromCapturedSources");
    const finishCancel = createDeferred();
    const drainStarted = createDeferred();
    const pending: Promise<unknown>[] = [];
    const drained = vi.fn<() => void>();
    let drainage: Promise<void> | undefined;
    if (mode === "callback-drain" || mode === "cancel-drain") {
      const { configureAiTransportRuntimeHost } =
        await import("../../agents/ai-transport-runtime-host.js");
      configureAiTransportRuntimeHost();
      const plugin = getAiTransportHost().plugin;
      const wrap = plugin.wrapSimpleCompletionStream;
      let first = true;
      vi.spyOn(plugin, "wrapSimpleCompletionStream").mockImplementation((params) => {
        const stream = wrap(params) ?? params.context.streamFn;
        return (model, context, options) =>
          stream(model, context, {
            ...options,
            onResponse: async (response, responseModel) => {
              await options?.onResponse?.(response, responseModel);
              if (first) {
                first = false;
                if (mode === "cancel-drain") {
                  throw new Error("fixture response rejected");
                }
                drainStarted.resolve();
                await finishCancel.promise;
              }
            },
          });
      });
    }
    if (mode === "cancel-drain") {
      const fetch = globalThis.fetch;
      let wrapped = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const response = await fetch(...args);
        if (wrapped || !response.url.startsWith(`${server.origin}/`)) {
          return response;
        }
        wrapped = true;
        const body = response.body!;
        return new Response(
          new ReadableStream<Uint8Array>({
            // The rejecting response hook cancels before consuming the body.
            async cancel(reason) {
              drainStarted.resolve();
              await finishCancel.promise;
              await body.cancel(reason);
            },
          }),
          { status: response.status, headers: response.headers },
        );
      });
    }
    const start = async (managed = false) => {
      const run = managed ? parent.track(() => runModel()) : runModel();
      await awaitGateBeforeSettlement(
        arrivals[pending.push(run) - 1]!.promise,
        run,
        "CLI settled before provider request",
      );
      return { run };
    };
    try {
      const { run: first } = await start(true);
      const firstBuilds = builds.mock.calls.length;
      if (mode === "provider-error") {
        requests[0]!.writeHead(400, { "content-type": "application/json" });
        requests[0]!.end(JSON.stringify({ error: { message: "fixture provider rejection" } }));
        await expect(first).rejects.toThrow("CLI failed");
        expect(errors.mock.calls.flat().join(" ")).toContain("fixture provider rejection");
      } else if (mode === "callback-drain") {
        finish(requests[0]!, 0);
        await Promise.race([drainStarted.promise, first]);
      } else if (mode === "cancel-drain") {
        // Keep the accepted body open so prefetch cannot settle it before cancellation.
        requests[0]!.writeHead(200, { "content-type": "text/event-stream" });
        requests[0]!.flushHeaders();
        await Promise.race([drainStarted.promise, first]);
        await expect(first).rejects.toThrow("CLI failed");
        drainage = parent.drain().then(drained);
      }
      const { run: second } = await start();
      expect.soft(builds.mock.calls.length).toBe(firstBuilds + (mode === "provider-error" ? 1 : 0));
      if (mode === "cancel-drain") {
        expect.soft(drained).not.toHaveBeenCalled();
      }
      finishCancel.resolve();
      finish(requests[0]!, 0);
      finish(requests[1]!, 1);
      if (mode === "overlap" || mode === "callback-drain") {
        await first;
      }
      await second;
      await drainage;
      expect(JSON.stringify(output.mock.calls.map(([value]) => value))).toContain("reply-1");
      const buildsBeforeThird = builds.mock.calls.length;
      const { run: third } = await start();
      expect(builds.mock.calls.length).toBe(buildsBeforeThird + 1);
      finish(requests[2]!, 2);
      await third;
    } finally {
      finishCancel.resolve();
      finishing = true;
      requests.forEach(finish);
      await Promise.allSettled(pending);
      await parent.drain();
    }
  },
);
