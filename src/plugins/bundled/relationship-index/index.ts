import type { OpenClawConfig } from "../../../config/config.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "../../types.js";
import {
  buildAfterToolCallGraphUpdate,
  buildBeforeMessageWriteGraphUpdate,
  buildMessageReceivedGraphUpdate,
  buildSubagentEndedGraphUpdate,
  buildSubagentSpawnedGraphUpdate,
  buildToolResultPersistGraphUpdate,
} from "./edges.js";
import { appendRelationshipIndexUpdate } from "./store.js";

export const RELATIONSHIP_INDEX_PLUGIN_ID = "relationship-index";

type RelationshipIndexPluginConfig = {
  compactAfterBytes?: number;
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function resolveAgentWorkspaceDir(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
): string | undefined {
  const normalizedAgentId = agentId?.trim();
  const list = Array.isArray(config?.agents?.list)
    ? config.agents.list.filter((entry): entry is AgentEntry =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
  const matched =
    (normalizedAgentId ? list.find((entry) => entry?.id === normalizedAgentId) : undefined) ??
    list.find((entry) => entry?.default === true);
  return matched?.workspace ?? config?.agents?.defaults?.workspace;
}

function resolveRepoRoot(config: OpenClawConfig | undefined): string | undefined {
  const value = config?.sre?.repoBootstrap?.rootDir;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function reportWriteFailure(api: Pick<OpenClawPluginApi, "logger">, err: unknown): void {
  api.logger.warn?.(`[relationship-index] failed to persist graph update: ${String(err)}`);
}

async function persistUpdate(
  api: Pick<OpenClawPluginApi, "logger">,
  update: ReturnType<typeof buildMessageReceivedGraphUpdate>,
  config: RelationshipIndexPluginConfig,
): Promise<void> {
  if (update.nodes.length === 0 && update.edges.length === 0) {
    return;
  }
  await appendRelationshipIndexUpdate(update, {
    env: process.env,
    compactAfterBytes:
      typeof config.compactAfterBytes === "number" && config.compactAfterBytes > 0
        ? config.compactAfterBytes
        : undefined,
  }).catch((err) => reportWriteFailure(api, err));
}

export function createRelationshipIndexPlugin(): OpenClawPluginDefinition {
  return {
    id: RELATIONSHIP_INDEX_PLUGIN_ID,
    name: "Relationship Index",
    description: "Captures runtime relationship nodes and edges for SRE provenance lookups.",
    configSchema: {
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          compactAfterBytes: {
            type: "integer",
            minimum: 1,
          },
        },
      },
    },
    register(api) {
      const pluginConfig = (api.pluginConfig ?? {}) as RelationshipIndexPluginConfig;

      api.on("message_received", async (event, ctx) => {
        await persistUpdate(api, buildMessageReceivedGraphUpdate(event, ctx), pluginConfig);
      });

      api.on("after_tool_call", async (event, ctx) => {
        await persistUpdate(
          api,
          buildAfterToolCallGraphUpdate(event, ctx, {
            workspaceDir: resolveAgentWorkspaceDir(api.config, ctx.agentId),
            repoRoot: resolveRepoRoot(api.config),
          }),
          pluginConfig,
        );
      });

      api.on("tool_result_persist", (event, ctx) => {
        void persistUpdate(
          api,
          buildToolResultPersistGraphUpdate(event, ctx, {
            workspaceDir: resolveAgentWorkspaceDir(api.config, ctx.agentId),
            repoRoot: resolveRepoRoot(api.config),
          }),
          pluginConfig,
        );
      });

      api.on("before_message_write", (event) => {
        void persistUpdate(
          api,
          buildBeforeMessageWriteGraphUpdate(event, {
            workspaceDir: resolveAgentWorkspaceDir(api.config, event.agentId),
            repoRoot: resolveRepoRoot(api.config),
          }),
          pluginConfig,
        );
      });

      api.on("subagent_spawned", async (event, ctx) => {
        await persistUpdate(
          api,
          buildSubagentSpawnedGraphUpdate(event, ctx, {
            workspaceDir: resolveAgentWorkspaceDir(api.config, event.agentId),
            repoRoot: resolveRepoRoot(api.config),
          }),
          pluginConfig,
        );
      });

      api.on("subagent_ended", async (event, ctx) => {
        await persistUpdate(api, buildSubagentEndedGraphUpdate(event, ctx), pluginConfig);
      });
    },
  };
}
