import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv, withEnvAsync } from "../../../test-utils/env.js";
import { loadOpenClawPlugins } from "../../loader.js";
import type { OpenClawPluginApi, PluginHookHandlerMap } from "../../types.js";
import { createRelationshipIndexPlugin } from "./index.js";
import { resolveRelationshipIndexStorePaths } from "./store.js";

const tempRoots: string[] = [];

function createTempEnv(): NodeJS.ProcessEnv {
  const root = path.join(os.tmpdir(), `openclaw-rel-plugin-${Date.now()}-${Math.random()}`);
  tempRoots.push(root);
  return {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SRE_GRAPH_DIR: path.join(root, "graph"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/openclaw-bundled-plugins",
  } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("relationship index plugin", () => {
  it("registers the provenance-producing hooks and writes graph artifacts", async () => {
    const handlers = new Map<string, PluginHookHandlerMap[keyof PluginHookHandlerMap]>();
    const env = createTempEnv();
    const plugin = createRelationshipIndexPlugin();
    const api = {
      config: {
        sre: {
          repoBootstrap: {
            rootDir: "/Users/florian/morpho",
          },
        },
        agents: {
          defaults: {
            workspace: "/Users/florian/morpho/openclaw-sre",
          },
        },
      },
      pluginConfig: {},
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      on(hookName: string, handler: PluginHookHandlerMap[keyof PluginHookHandlerMap]) {
        handlers.set(hookName, handler);
      },
    } as unknown as OpenClawPluginApi;

    await plugin.register?.(api);
    expect([...handlers.keys()]).toEqual([
      "message_received",
      "after_tool_call",
      "tool_result_persist",
      "before_message_write",
      "subagent_spawned",
      "subagent_ended",
    ]);

    await withEnvAsync(env, async () => {
      await (handlers.get("message_received") as PluginHookHandlerMap["message_received"])(
        {
          from: "u1",
          content: "hello",
          timestamp: Date.parse("2026-03-07T12:00:00.000Z"),
          metadata: {
            messageId: "msg-1",
            threadId: "thread-1",
          },
        },
        {
          channelId: "slack",
          conversationId: "channel:#alerts",
        },
      );
      await (handlers.get("after_tool_call") as PluginHookHandlerMap["after_tool_call"])(
        {
          toolName: "read",
          params: { path: "/tmp/file.txt" },
          toolCallId: "call-1",
          runId: "run-1",
          result: { ok: true },
          parentEntityId: "session:abc123",
        },
        {
          toolName: "read",
          agentId: "main",
          sessionKey: "agent:main:slack:user:u1",
          sessionId: "sess-1",
          runId: "run-1",
          toolCallId: "call-1",
        },
      );
      await (handlers.get("subagent_spawned") as PluginHookHandlerMap["subagent_spawned"])(
        {
          childSessionKey: "agent:worker:slack:user:u1",
          agentId: "worker",
          mode: "run",
          threadRequested: false,
          runId: "run-sub",
          entityId: "subagent:xyz",
        },
        {
          childSessionKey: "agent:worker:slack:user:u1",
          requesterSessionKey: "agent:main:slack:user:u1",
          runId: "run-sub",
        },
      );
    });

    const paths = resolveRelationshipIndexStorePaths(env);
    const [nodesRaw, edgesRaw, latestRaw] = await Promise.all([
      fs.readFile(paths.nodesPath, "utf8"),
      fs.readFile(paths.edgesPath, "utf8"),
      fs.readFile(paths.latestByEntityPath, "utf8"),
    ]);
    expect(nodesRaw).toContain('"entityType":"message"');
    expect(nodesRaw).toContain('"entityType":"tool_call"');
    expect(nodesRaw).toContain('"entityType":"subagent"');
    expect(edgesRaw).toContain('"edgeType":"belongs_to"');
    expect(edgesRaw).toContain('"edgeType":"calls"');
    expect(edgesRaw).toContain('"edgeType":"depends_on"');
    expect(latestRaw).toContain('"nodes"');
  });

  it("loads from the plugin loader only when the sre gate is enabled", () => {
    const env = createTempEnv();
    withEnv(env, () => {
      const disabled = loadOpenClawPlugins({
        cache: false,
        config: {},
      });
      expect(disabled.plugins.some((entry) => entry.id === "relationship-index")).toBe(false);

      const enabled = loadOpenClawPlugins({
        cache: false,
        config: {
          sre: {
            relationshipIndex: {
              enabled: true,
            },
          },
        },
      });
      expect(enabled.plugins.some((entry) => entry.id === "relationship-index")).toBe(true);
    });
  });
});
