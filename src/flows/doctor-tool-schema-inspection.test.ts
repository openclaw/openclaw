import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mcpConfig from "../agents/agent-bundle-mcp-runtime-config.js";
import { createMcpProofPluginRegistry } from "../agents/mcp-connection-resolver.test-fixtures.js";
import { configFor, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runtimeToolSchemaCheck } from "./doctor-tool-schema-check.js";
import type { HealthFinding } from "./health-checks.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

it.each([
  ["doctor", "tools"],
  ["lint", "tools"],
  ["doctor", "missing-provider-collision"],
  ["doctor", "provider-collision"],
  ["doctor", "provider-without-tools"],
  ["lint", "provider-collision"],
  ["doctor", "legacy-provider-collision"],
  ["doctor", "cleanup-errors"],
] as const)("inspects each agent through one registration in %s (%s)", async (mode, variant) => {
  const fails = mode === "lint";
  const collision = variant.endsWith("collision");
  const withoutPluginTools = variant === "provider-without-tools";
  const toolName = collision ? "web_search" : "fleet_tool";
  const providerOnly = variant !== "tools" && variant !== "missing-provider-collision";
  const providerPluginId = "z-search-provider";
  const registeredPluginIds = [
    ...(withoutPluginTools ? [] : ["failed-tool", "fleet-tool"]),
    ...(providerOnly ? [providerPluginId] : []),
  ].toSorted();
  await withOpenClawTestState(
    {
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_SUPPLEMENTAL_SEARCH_KEY: "synthetic-search-key",
      },
    },
    async (state) => {
      const events = state.path("doctor-tool-events.jsonl");
      const unexpectedProbe = state.path("requester-server-probed");
      const ids = [
        "fleet-tool",
        "failed-tool",
        "excluded-tool",
        ...(providerOnly ? [providerPluginId] : []),
      ];
      const paths = ids.map((id) => {
        const root = state.path("plugins", id);
        fs.mkdirSync(root, { recursive: true });
        const writeJson = (name: string, value: unknown) =>
          fs.writeFileSync(path.join(root, name), JSON.stringify(value));
        writeJson("package.json", {
          name: id,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        writeJson("openclaw.plugin.json", {
          id,
          contracts: {
            ...(id !== providerPluginId
              ? { tools: [id === "fleet-tool" ? toolName : id.replaceAll("-", "_")] }
              : {}),
            ...(id === providerPluginId && variant !== "legacy-provider-collision"
              ? { webSearchProviders: ["fixture-search"] }
              : {}),
          },
          configSchema: { type: "object", additionalProperties: false },
        });
        fs.writeFileSync(
          path.join(root, "index.cjs"),
          `
const fs = require("node:fs");
const file = ${JSON.stringify(events)};
const id = ${JSON.stringify(id)};
if (id === "excluded-tool") throw new Error("excluded owner must remain cold");
module.exports = { id, register(api) {
  api.lifecycle.onDispose(() => {
    fs.appendFileSync(file, JSON.stringify(id) + "\\n");
    if (${variant === "cleanup-errors"} && id !== "failed-tool") throw new Error(id + " cleanup unavailable");
  });
  if (id === "failed-tool") throw new Error("fixture registration unavailable");
  if (id === ${JSON.stringify(providerPluginId)}) {
    api.registerWebSearchProvider({
      id: "fixture-search", label: "Search fixture", hint: "Synthetic search",
      envVars: ["OPENCLAW_TEST_SUPPLEMENTAL_SEARCH_KEY"],
      placeholder: "", signupUrl: "https://example.com", credentialPath: "",
      getCredentialValue() {}, setCredentialValue() {},
      createTool() { throw new Error("Schema inspection must not execute search providers"); }
    });
  }
  if (id === ${JSON.stringify(providerPluginId)}) return;
  api.registerTool(() => {
    return { name: ${JSON.stringify(toolName)}, label: "Fleet fixture", description: "Synthetic fleet tool",
      parameters: {type: "array", items: {type: "string"}},
      execute: async () => ({content: [{type: "text", text: "unused"}]}) };
  }, {name: ${JSON.stringify(toolName)}});
} };
`,
        );
        return root;
      });
      const inspectedAgent = (id: string) => ({
        workspace: state.path(id),
        tools: {
          allow: withoutPluginTools
            ? ["web_search", "requester__*"]
            : [toolName, "failed_tool", "requester__*"],
        },
      });
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "alpha" }, model: "fixture/local" },
          entries: {
            alpha: inspectedAgent("alpha"),
            beta: inspectedAgent("beta"),
            excluded: { workspace: state.path("excluded"), tools: { deny: ["group:plugins"] } },
          },
        },
        ...configFor("fixture", "http://127.0.0.1:1/v1", {
          api: "openai-completions",
          models: [modelDefinition("local", { reasoning: false })],
        }),
        plugins: { allow: ids, load: { paths }, slots: { memory: "none" } },
        mcp: {
          servers: {
            requester: {
              command: process.execPath,
              args: [
                "-e",
                `require("node:fs").writeFileSync(${JSON.stringify(unexpectedProbe)}, "probed"); process.exit(1);`,
              ],
            },
          },
        },
      };
      const caller = createMcpProofPluginRegistry();
      const resolveRequester = vi.fn(() => {
        throw new Error("Doctor has no authenticated requester");
      });
      caller.apiFor("requester-owner").registerMcpServerConnectionResolver({
        serverName: "requester",
        resolve: resolveRequester,
      });
      const detectorFailure = new Error("fixture detector failed after tool inspection");
      const loadMcpConfig = mcpConfig.loadSessionMcpConfig;
      if (fails) {
        vi.spyOn(mcpConfig, "loadSessionMcpConfig").mockImplementation((request) => {
          if (request.workspaceDir === state.path("beta")) {
            throw detectorFailure;
          }
          return loadMcpConfig(request);
        });
      }
      const operation = withPluginRuntimeRegistryScope(caller.registry, () =>
        runtimeToolSchemaCheck.detect({ mode, cfg, runtime: defaultRuntime, env: process.env }),
      );
      if (fails) {
        await expect(operation).rejects.toBe(detectorFailure);
      } else {
        const findings = await operation;
        const expectFinding = (fields: Partial<HealthFinding>) =>
          expect(findings).toContainEqual(expect.objectContaining(fields));
        expectFinding({
          severity: "info",
          path: "mcp.servers.requester",
          requirement: "authenticated requester context",
        });
        expect(findings.filter((finding) => finding.target === toolName)).toEqual(
          (withoutPluginTools || (collision && providerOnly) ? [] : ["alpha", "beta"]).map(
            (agentId) =>
              expect.objectContaining({
                message: expect.stringContaining(
                  `Agent ${agentId} tool ${toolName} from plugin fleet-tool`,
                ),
                path: "plugins.entries.fleet-tool",
              }),
          ),
        );
        if (!withoutPluginTools) {
          expectFinding({
            target: "failed-tool",
            requirement: expect.stringContaining("fixture registration unavailable"),
          });
        }
        if (variant === "cleanup-errors") {
          expectFinding({
            message: "Runtime tool schema inspection could not confirm plugin cleanup.",
            requirement: expect.stringContaining("Plugin tool inspection cleanup failed"),
          });
        }
      }
      expect(resolveRequester).not.toHaveBeenCalled();
      expect(fs.existsSync(unexpectedProbe)).toBe(false);
      expect(
        fs
          .readFileSync(events, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .toSorted(),
      ).toEqual(registeredPluginIds);
    },
  );
});
