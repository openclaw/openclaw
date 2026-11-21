import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { buildCliMcpGrantContext } from "../agents/cli-runner/mcp-grant-context.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";

const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

it("preserves native conversation identity through CLI grants and plugin invocation", async ({
  signal,
}) =>
  fixtureLifetime.run(async () => {
    const root = fixtureLifetime.createTempDir("mcp-plugin-context-");
    const bundledDir = path.join(root, "bundled");
    const pluginDir = path.join(bundledDir, "context-probe");
    const workspaceDir = path.join(root, "workspace");
    let instance: PluginInstanceHandle | undefined;
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: { allow: ["context-probe"], entries: { "context-probe": { enabled: true } } },
      tools: { allow: ["context_probe"] },
    };
    await runQaGatewayFixture(
      async () => {
        vi.stubEnv("OPENCLAW_HOME", root);
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
        vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
        vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
        writeJsonFile(path.join(pluginDir, "package.json"), {
          name: "@openclaw/context-probe",
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
          openclaw: { extensions: ["./index.cjs"] },
        });
        writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
          id: "context-probe",
          configSchema: { type: "object", additionalProperties: false },
          contracts: { tools: ["context_probe"] },
        });
        fs.writeFileSync(
          path.join(pluginDir, "index.cjs"),
          `module.exports = {
          id: "context-probe", register(api) {
            api.registerTool((ctx) => ({
              name: "context_probe", label: "Context probe", description: "Report conversation context",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [{ type: "text", text: JSON.stringify({
                nativeChannelId: ctx.nativeChannelId ?? null, target: ctx.deliveryContext?.to
              }) }] })
            }), { name: "context_probe" });
          }
        };`,
        );
        configSnapshot.setRuntimeConfigSnapshot(config);
        const generation = withPluginCache(createPluginCache(), () => {
          const metadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
          const pluginRegistry = loadPluginRegistryHandle({
            config,
            workspaceDir,
            manifestRegistry: metadataSnapshot.manifestRegistry,
            onlyPluginIds: ["context-probe"],
          });
          const record = pluginRegistry.plugins.find((plugin) => plugin.id === "context-probe");
          instance = expectDefined(record && getPluginInstance(record), "plugin instance");
          return { pluginRegistry, metadataSnapshot };
        });
        setActivePluginRegistry(generation.pluginRegistry);
        await withPluginRuntimeGenerationScope(generation, ensureMcpLoopbackServer);
        for (const chatId of ["native-room-123", undefined]) {
          const runId = `context-${chatId ?? "absent"}`;
          const admission = mcp.prepareAdmission(runId, "plugin-context-test", { cfg: config });
          const context = buildCliMcpGrantContext({
            run: {
              sessionId: runId,
              sessionFile: path.join(root, `${runId}.jsonl`),
              sessionKey: "agent:main:main",
              runId,
              workspaceDir,
              prompt: "inspect conversation",
              provider: "claude-cli",
              timeoutMs: 1000,
              messageProvider: "slack",
              currentChannelId: "channel:delivery-456",
              chatId,
              senderIsOwner: true,
            },
            config,
            agentId: "main",
            modelProvider: "anthropic",
            modelId: "fixture",
            requireExplicitMessageTarget: false,
          });
          let token: string | undefined;
          try {
            const grant = mcp.captureGrant(
              {
                context,
                runtimeOwnerToken: mcp.runtime().ownerToken,
                admittedRunContext: await admission.admit("gateway", runId),
                toolPolicyConfig: config,
              },
              runId,
              (value) => {
                token = value;
              },
            );
            const payload = await mcp.json(
              await mcp.request(mcp.runtime(), mcp.toolCall("context_probe"), {
                token: grant.token,
                captureKey: runId,
                signal,
                connection: "close",
                sessionKey: "agent:spoofed:main",
              }),
            );
            expect(payload).toMatchObject({
              result: {
                isError: false,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      nativeChannelId: chatId ?? null,
                      target: "channel:delivery-456",
                    }),
                  },
                ],
              },
            });
          } finally {
            if (token) {
              revokeMcpLoopbackClientGrant(token);
            }
            admission.close();
          }
        }
      },
      closeMcpLoopbackServer,
      () => instance?.dispose(),
      () => resetPluginRuntimeStateForTest(),
      () => configSnapshot.clearRuntimeConfigSnapshot(),
      () => vi.unstubAllEnvs(),
    );
  }));
