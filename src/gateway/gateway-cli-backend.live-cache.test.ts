import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawPluginToolFactory } from "../plugins/types.js";
import {
  CLI_ANNOUNCE_BARRIER_TOOL_NAME,
  createCliBackendProbePlugin,
} from "./gateway-cli-backend.live-cache.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps the CLI announcement controller barrier out of child tools", async () => {
  const { pluginPath } = await createCliBackendProbePlugin(tempDirs.make("cli-announce-scope-"), {
    mcpSchema: false,
    announceBarrierUrl: "http://127.0.0.1:1/unused",
  });
  const registrations: Array<AnyAgentTool | OpenClawPluginToolFactory> = [];
  const require = createRequire(import.meta.url);
  const plugin: {
    register(api: { registerTool(tool: AnyAgentTool | OpenClawPluginToolFactory): void }): void;
  } = require(path.join(pluginPath, "index.cjs"));
  plugin.register({ registerTool: (tool) => registrations.push(tool) });
  const toolsFor = (sessionKey: string) =>
    registrations.flatMap((registration) => {
      const tools =
        typeof registration === "function" ? registration({ sessionKey }) : registration;
      return tools ? (Array.isArray(tools) ? tools : [tools]) : [];
    });
  expect(toolsFor("agent:dev:cli-announce-proof").map((tool) => tool.name)).toEqual([
    CLI_ANNOUNCE_BARRIER_TOOL_NAME,
  ]);
  expect(toolsFor("agent:dev:subagent:proof")).toEqual([]);
});
