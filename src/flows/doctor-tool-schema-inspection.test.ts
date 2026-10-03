import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mcpConfig from "../agents/agent-bundle-mcp-runtime-config.js";
import { createMcpProofPluginRegistry } from "../agents/mcp-connection-resolver.test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as discovery from "../plugins/discovery.js";
import * as manifests from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import * as pluginTools from "../plugins/tools.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

it.each([
  { mode: "doctor", fails: false },
  { mode: "lint", fails: true },
] as const)(
  "inspects each agent through one registration in $mode with detector failure=$fails",
  async ({ mode, fails }) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const events = state.path("doctor-tool-events.jsonl");
        const unexpectedProbe = state.path("requester-server-probed");
        const ids = ["fleet-tool", "failed-tool", "excluded-tool"];
        const paths = ids.map((id) => {
          const root = state.path("plugins", id);
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({
              name: id,
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          fs.writeFileSync(
            path.join(root, "openclaw.plugin.json"),
            JSON.stringify({
              id,
              contracts: { tools: [id.replaceAll("-", "_")] },
              configSchema: { type: "object", additionalProperties: false },
            }),
          );
          fs.writeFileSync(
            path.join(root, "index.cjs"),
            `
const fs = require("node:fs");
const file = ${JSON.stringify(events)};
const id = ${JSON.stringify(id)};
if (id === "excluded-tool") throw new Error("excluded owner must remain cold");
const event = (kind, details = {}) => fs.appendFileSync(file, JSON.stringify({id, kind, ...details}) + "\\n");
module.exports = { id, register(api) {
  const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
  event("register");
  api.lifecycle.onDispose(() => event("dispose"));
  if (prior.some(row => row.id === id && row.kind === "register")) throw new Error("repeated fleet registration");
  if (id === "failed-tool") throw new Error("fixture registration unavailable");
  api.registerTool(context => {
    event("factory", {agentId: context.agentId, workspaceDir: context.workspaceDir});
    return { name: "fleet_tool", label: "Fleet fixture", description: "Synthetic fleet tool",
      parameters: {type: "array", items: {type: "string"}},
      execute: async () => ({content: [{type: "text", text: "unused"}]}) };
  }, {name: "fleet_tool"});
} };
`,
          );
          return root;
        });
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "alpha" }, model: "fixture/local" },
            entries: {
              alpha: {
                workspace: state.path("alpha"),
                tools: {
                  allow: ["fleet_tool", "failed_tool", "requester__*"],
                },
              },
              beta: {
                workspace: state.path("beta"),
                tools: {
                  allow: ["fleet_tool", "failed_tool", "requester__*"],
                },
              },
              excluded: { workspace: state.path("excluded"), tools: { deny: ["group:plugins"] } },
            },
          },
          models: {
            providers: {
              fixture: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:1/v1",
                models: [
                  {
                    id: "local",
                    name: "Local fixture",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
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
        const check = CORE_HEALTH_CHECKS.find(
          (entry) => entry.id === "core/doctor/runtime-tool-schemas",
        );
        expect(check).toBeDefined();
        const caller = createMcpProofPluginRegistry();
        caller.apiFor("requester-owner").registerMcpServerConnectionResolver({
          serverName: "requester",
          resolve: () => {
            throw new Error("Doctor has no authenticated requester");
          },
        });
        const detectorFailure = new Error("fixture detector failed after tool inspection");
        const rejectColdRead = vi.fn(() => {
          throw new Error("cold plugin metadata read after inspection preparation");
        });
        const acquireInspection = pluginTools.acquirePluginToolInspectionRegistry;
        const loadMcpConfig = mcpConfig.loadSessionMcpConfig;
        vi.spyOn(pluginTools, "acquirePluginToolInspectionRegistry").mockImplementation(
          async (params) => {
            const inspection = await acquireInspection(params);
            vi.spyOn(discovery, "discoverOpenClawPlugins").mockImplementation(rejectColdRead);
            vi.spyOn(manifests, "loadPluginManifestRegistryCore").mockImplementation(
              rejectColdRead,
            );
            if (fails) {
              vi.spyOn(mcpConfig, "loadSessionMcpConfig").mockImplementation((request) => {
                if (request.workspaceDir === state.path("beta")) {
                  throw detectorFailure;
                }
                return loadMcpConfig(request);
              });
            }
            return inspection;
          },
        );
        const operation = withPluginRuntimeRegistryScope(caller.registry, () =>
          check!.detect({
            mode,
            cfg,
            runtime: defaultRuntime,
            env: process.env,
          }),
        );
        if (fails) {
          await expect(operation).rejects.toBe(detectorFailure);
        } else {
          const findings = await operation;
          expect(findings).toContainEqual(
            expect.objectContaining({
              severity: "info",
              path: "mcp.servers.requester",
              requirement: "authenticated requester context",
            }),
          );
          expect(findings.filter((finding) => finding.target === "fleet_tool")).toEqual(
            ["alpha", "beta"].map((agentId) =>
              expect.objectContaining({
                message: expect.stringContaining(
                  `Agent ${agentId} tool fleet_tool from plugin fleet-tool`,
                ),
                path: "plugins.entries.fleet-tool",
              }),
            ),
          );
          expect(findings).toContainEqual(
            expect.objectContaining({
              target: "failed-tool",
              requirement: expect.stringContaining("fixture registration unavailable"),
            }),
          );
        }
        expect(rejectColdRead).not.toHaveBeenCalled();
        expect(fs.existsSync(unexpectedProbe)).toBe(false);
        const observed = fs
          .readFileSync(events, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          observed
            .filter((row) => row.kind === "register")
            .map((row) => row.id)
            .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(["failed-tool", "fleet-tool"]);
        expect(observed.filter((row) => row.kind === "factory")).toEqual(
          ["alpha", "beta"].map((agentId) => ({
            id: "fleet-tool",
            kind: "factory",
            agentId,
            workspaceDir: state.path(agentId),
          })),
        );
        expect(
          observed
            .filter((row) => row.kind === "dispose")
            .map((row) => row.id)
            .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(["failed-tool", "fleet-tool"]);
      },
    );
  },
);

it.each([
  {
    name: "closed MCP transport",
    server: { command: process.execPath, args: ["-e", "process.exit(1)"] as string[] },
    severity: "warning",
    errorCode: "mcp-service-unavailable",
  },
  {
    name: "missing local executable",
    server: { command: "/nonexistent/openclaw-mcp-doctor-test-command" },
    severity: "error",
    errorCode: undefined,
  },
  {
    name: "refused remote HTTP connection",
    server: undefined,
    severity: "warning",
    errorCode: "mcp-service-unavailable",
  },
] as const)(
  "reports $name through the Doctor runtime check",
  async ({ server, severity, errorCode }) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const configuredServer = server ?? {
          url: `http://127.0.0.1:${await getFreePort()}/mcp`,
          transport: "streamable-http" as const,
        };
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { model: "fixture/local", workspace: state.path("workspace") },
          },
          models: {
            providers: {
              fixture: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:1/v1",
                models: [
                  {
                    id: "local",
                    name: "Local fixture",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          mcp: { servers: { broken: configuredServer } },
        };
        const check = CORE_HEALTH_CHECKS.find(
          (entry) => entry.id === "core/doctor/runtime-tool-schemas",
        );
        expect(check).toBeDefined();
        const findings = await check!.detect({
          mode: "lint",
          cfg,
          runtime: defaultRuntime,
          env: process.env,
        });
        expect(findings).toContainEqual(
          expect.objectContaining({
            checkId: "core/doctor/runtime-tool-schemas",
            path: "mcp.servers.broken",
            severity,
            ...(errorCode ? { errorCode } : {}),
          }),
        );
        if (!errorCode) {
          expect(
            findings.find((finding) => finding.path === "mcp.servers.broken")?.errorCode,
          ).toBeUndefined();
        }
      },
    );
  },
);
