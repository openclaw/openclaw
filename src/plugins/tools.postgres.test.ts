import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawPluginToolsForOptionsAsync } from "../agents/openclaw-plugin-tools.js";
import { runWithAgentWorkspaceReadiness } from "../agents/workspace-readiness.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../infra/database-engine/mixed-agent.conformance.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotAsync } from "./plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

// A test Worker would bypass the Gateway's PostgreSQL main-thread restriction.
expect(threadId).toBe(0);
installDatabaseProcessRole("gateway");

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(`${engine} plugin tools`, () => {
    for (const workspaceReady of [false, true]) {
      describe(`workspace readiness=${workspaceReady}`, () => {
        const fixture = useMixedAgentPair(engine, "sqlite");
        it("loads and invokes cold tools", async () => {
          vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
          // Boot admission creates the shared store. Turn-time reads must use its worker.
          withEngineStoreAdmission(() => openOpenClawStateDatabase());
          const pluginDir = path.join(fixture.root, `tool-${workspaceReady}`);
          fs.mkdirSync(pluginDir);
          fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify({
              name: "cold-tool",
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: "cold-tool",
              contracts: { tools: ["cold_tool"] },
              configSchema: { type: "object" },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "index.cjs"),
            `module.exports = { id: "cold-tool", register(api) {
          api.registerTool({ name: "cold_tool", label: "Cold tool", description: "Synthetic tool",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [{ type: "text", text: "cold tool ran" }] }) });
        } };`,
          );
          const config: OpenClawConfig = {
            plugins: {
              allow: ["cold-tool"],
              load: { paths: [pluginDir] },
              slots: { memory: "none" },
            },
          };
          const sessionKey = `agent:main:tools-${workspaceReady}`;
          const resolve = () =>
            resolveOpenClawPluginToolsForOptionsAsync({
              options: { config, agentSessionKey: sessionKey, pluginToolAllowlist: ["cold_tool"] },
            });
          await using cache = createPluginCache();
          await withPluginCache(cache, async () => {
            // Gateway startup prepares metadata, but does not load these tool registrations.
            const metadata = await resolvePluginMetadataSnapshotAsync({ config, env: process.env });
            setGatewayPluginMetadataSnapshot(metadata, { config, env: process.env });
            const tools = await (workspaceReady
              ? runWithAgentWorkspaceReadiness(
                  {
                    sessionKey,
                    isReady: () => true,
                    assertCurrent() {},
                    waitUntilReady: async () => {},
                  },
                  resolve,
                )
              : resolve());
            expect(tools.map((tool) => tool.name)).toEqual(["cold_tool"]);
            expect(await tools[0]!.execute("call", {})).toMatchObject({
              content: [{ type: "text", text: "cold tool ran" }],
            });
          });
        });
      });
    }
  });
}
