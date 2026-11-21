import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as setupAccess from "../agents/auth-profiles/setup-access.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { prepareCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import { groqSetupSdkEntrypoints } from "./setup-inference-groq-sdk.test-support.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const error = "The connection changed before credential activation. Test the saved sign-in again.";

afterEach(async () => {
  vi.restoreAllMocks();
  configureAiTransportHost({});
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  await waitForPluginCacheRetirement();
});

it.each([
  ["model selection", undefined, false],
  ["access only", false, false],
  ["access-only drift", false, true],
] as const)(
  "resolves a Groq manifest model from a global external install during setup (%s)",
  (_mode, selectModel, drift) => runGroqSetup(selectModel, drift),
);

async function runGroqSetup(selectModel: false | undefined, drift: boolean) {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  clearLoadInstalledPluginIndexInstallRecordsCache();
  const sdkHost = prepareCompiledSdkHost(groqSetupSdkEntrypoints)((prefix) =>
    tempDirs.make(prefix),
  );
  await withOpenClawTestState(
    {
      label: "groq-external-setup",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DEV_SOURCE_ROOT: sdkHost,
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
    },
    async (state) => {
      const pluginDir = state.statePath("extensions", "groq");
      // This fixture owns its SDK peer; checkout dependency directories may be borrowed links.
      await fs.cp(path.join(process.cwd(), "extensions", "groq"), pluginDir, {
        recursive: true,
        filter: (source) => path.basename(source) !== "node_modules",
      });
      // Sparse CI may omit the runtime entry; retain the real manifest/discovery
      // and supply only the package and text-provider entry this flow needs.
      for (const [file, content] of Object.entries({
        "package.json": JSON.stringify({
          name: "@openclaw/groq-provider",
          version: "2026.9.4",
          type: "module",
          openclaw: { extensions: ["./index.ts"], compat: { pluginApi: ">=2026.9.4" } },
        }),
        "index.ts": `import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default defineSingleProviderPluginEntry({
  id: "groq",
  name: "Groq Provider",
  description: "Bundled Groq provider plugin",
  manifest,
  provider: {
    label: "Groq",
    docsPath: "/providers/groq",
    catalog: { liveModelDiscovery: true, discoveryMode: "strict" },
  },
});
`,
      })) {
        await fs.writeFile(path.join(pluginDir, file), content, "utf8");
      }
      const hostRoot =
        sdkHost ??
        resolveOpenClawPackageRootSync({
          argv1: process.argv[1],
          moduleUrl: import.meta.url,
          cwd: process.cwd(),
        });
      if (!hostRoot) {
        throw new Error("test host package root is unavailable");
      }
      await fs.mkdir(path.join(pluginDir, "node_modules"), { recursive: true });
      await fs.symlink(hostRoot, path.join(pluginDir, "node_modules", "openclaw"), "junction");
      const config = { plugins: { entries: { groq: { enabled: true } } } };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config, config);
      onTestFinished(clearRuntimeConfigSnapshot);
      await seedInstalledPluginIndex(
        { groq: { source: "path", sourcePath: pluginDir, installPath: pluginDir } },
        { config, env: state.env },
      );
      clearLoadInstalledPluginIndexInstallRecordsCache();

      let committing = false;
      let edited = false;
      const withSetupCredentialAccess = setupAccess.withSetupCredentialAccess;
      vi.spyOn(setupAccess, "withSetupCredentialAccess").mockImplementation(async (params, run) => {
        if (drift && committing && !edited) {
          const committed = await readConfigFileSnapshot();
          committed.sourceConfig.models = {
            providers: {
              groq: { baseUrl: "https://changed.test/v1", api: "openai-completions", models: [] },
            },
          };
          await state.writeConfig(committed.sourceConfig);
          edited = true;
        }
        return await withSetupCredentialAccess(params, run);
      });

      const requests: Array<{ method?: string; url?: string }> = [];
      const { runtime, lines: runtimeErrors } = createSystemAgentTestRuntime();
      const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        const chunk = {
          id: "chatcmpl-groq-catalog-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "openai/gpt-oss-120b",
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
        };
        const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        response.end(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`,
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("loopback server has no TCP port");
      }

      const realFetch = globalThis.fetch;
      const originalHost = getAiTransportHost();
      configureAiTransportHost({
        ...originalHost,
        buildModelFetch: () => async (input, init) => {
          const original = new Request(input, init);
          const replacement = new URL(original.url);
          expect(replacement.hostname).toBe("api.groq.com");
          replacement.protocol = "http:";
          replacement.hostname = "127.0.0.1";
          replacement.port = String(address.port);
          return await realFetch(new Request(replacement, original));
        },
      });

      try {
        const result = await activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "test-placeholder",
          modelRef: "groq/openai/gpt-oss-120b",
          ...(selectModel === false ? { selectModel } : {}),
          workspace: state.workspaceDir,
          surface: "gateway",
          runtime,
          onCommitStarted: () => {
            committing = true;
          },
        });

        expect(result, JSON.stringify({ result, runtimeErrors, requests })).toMatchObject(
          drift ? { ok: false, error } : { ok: true, modelRef: "groq/openai/gpt-oss-120b" },
        );
        expect(edited).toBe(drift);
        expect(requests).toEqual([{ method: "POST", url: "/openai/v1/chat/completions" }]);
        if (selectModel === false) {
          const committed = await readConfigFileSnapshot();
          expect(committed.sourceConfig.agents?.defaults?.model).toBeUndefined();
          const profiles = (
            await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir())
          ).profiles;
          const credential = Object.values(profiles).find((profile) => profile.provider === "groq");
          expect(credential).toBeDefined();
          expect(credential?.setup).toEqual(drift ? expect.any(Object) : undefined);
        }
      } finally {
        configureAiTransportHost(originalHost);
        server.close();
        await once(server, "close");
      }
    },
  );
}
