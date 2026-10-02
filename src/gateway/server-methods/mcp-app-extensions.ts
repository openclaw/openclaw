import { randomUUID } from "node:crypto";
import { ResourceLinkSchema } from "@modelcontextprotocol/sdk/types.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { runWithSessionMcpRequestSignal } from "../../agents/agent-bundle-mcp-request-context.js";
import type { McpCatalogTool } from "../../agents/agent-bundle-mcp-types.js";
import { readMcpAppSettings } from "../../agents/mcp-app-extension-metadata.js";
import {
  buildMcpAppCanvasPayload,
  fetchMcpAppView,
  getMcpAppViewLease,
  type McpAppHostFile,
} from "../../agents/mcp-ui-resource.js";
import { logWarn } from "../../logger.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { iteratePluginRootContributions } from "../../plugins/plugin-root-contributions.js";
import type { McpAppDiscoverResult } from "../../shared/mcp-app-extensions.js";
import { prepareMcpAppExtensionRuntime } from "../mcp-app-extension-runtime.js";
import { prepareMcpAppHostFile } from "../mcp-app-host-files.js";
import { callMcpAppToolWithElicitation } from "../mcp-app-operations.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

type Prepared = Awaited<ReturnType<typeof prepareMcpAppExtensionRuntime>>;
const text = z.string().trim().min(1).max(2_048);
const targetSchema = z.object({ sessionKey: text, agentId: text.optional() });
const launchSchema = targetSchema.extend({
  serverName: text,
  toolName: text,
  entrypointType: z.enum(["global", "thread", "file", "settings"]),
  quickAction: z.boolean().optional(),
  filePath: text.optional(),
  deepLink: text.optional(),
});
const settingsSchema = targetSchema.extend({
  serverName: text,
  action: z.enum(["read", "update", "tool"]),
  toolName: text.optional(),
  arguments: z
    .object({ set: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])) })
    .optional(),
});
const mentionSchema = targetSchema.extend({ serverName: text, query: z.string().max(2_048) });
function toolFor(active: Prepared, serverName: string, toolName: string) {
  const tool = active.catalog.tools.find(
    (candidate) => candidate.serverName === serverName && candidate.toolName === toolName,
  );
  if (!tool) {
    throw new Error("MCP App tool is unavailable or denied");
  }
  active.assertTool(tool);
  return tool;
}
function appToolsFor(active: Prepared, serverName: string) {
  return active.catalog.tools.filter((candidate) => {
    if (
      candidate.serverName !== serverName ||
      (candidate.uiVisibility !== undefined && !candidate.uiVisibility.includes("app"))
    ) {
      return false;
    }
    try {
      active.assertTool(candidate);
      return true;
    } catch {
      return false;
    }
  });
}
async function uploadFor(active: Prepared, serverName: string, assertCurrent: () => void) {
  const { prepareMcpAppFormUpload } = await import("../../agents/mcp-form-resource-upload.js");
  return await prepareMcpAppFormUpload({
    runtime: active.runtime,
    serverName,
    agentId: active.agentId,
    sessionKey: active.sessionKey,
    requesterId: active.requesterId,
    assertCurrent,
  });
}
async function call(active: Prepared, tool: McpCatalogTool, input: Record<string, unknown>) {
  const assertCurrent = await active.approveTool(tool, input);
  const formAuthority = active.retainViewAuthority(appToolsFor(active, tool.serverName));
  let result;
  try {
    result = await callMcpAppToolWithElicitation({
      options: active.options,
      uploadResources: await uploadFor(active, tool.serverName, assertCurrent),
      origin: {
        runtime: active.runtime,
        serverName: tool.serverName,
        agentId: active.agentId,
        sessionKey: active.sessionKey,
        requesterId: active.requesterId,
        assertCurrent,
        prepareToolCall: formAuthority.prepareToolCall,
      },
      toolName: tool.toolName,
      input,
      assertCurrent,
    });
  } finally {
    formAuthority.release();
  }

  active.assertCurrent();
  return result;
}
async function launch(
  active: Prepared,
  tool: McpCatalogTool,
  input: Record<string, unknown>,
  extra?: { hostFile?: McpAppHostFile; deepLink?: { url: string } },
) {
  if (!tool.uiResourceUri?.startsWith("ui://")) {
    throw new Error("MCP App resource is unavailable");
  }
  const result = await call(active, tool, input);
  if (result.isError) {
    return { toolResult: result };
  }
  // The retained authority is released by the view's existing runtime lease owner.
  const viewTools = appToolsFor(active, tool.serverName);
  const retained = active.retainViewAuthority(viewTools);
  let transferred = false;
  try {
    const viewRuntime = active.runtime;
    const allowedAppToolNames = new Set(viewTools.map((candidate) => candidate.toolName));
    const view = await fetchMcpAppView({
      runtime: viewRuntime,
      agentId: active.agentId,
      serverName: tool.serverName,
      toolName: tool.toolName,
      uiResourceUri: tool.uiResourceUri,
      toolCallId: randomUUID(),
      toolInput: input,
      toolResult: result,
      allowedAppToolNames,
      requesterId: active.requesterId,
      displayMode: "fullscreen",
      prepareToolCall: retained.prepareToolCall,
      uploadResources: await uploadFor(active, tool.serverName, retained.assertCurrent),
      ...extra,
      authorizeAppInteraction: () => {
        retained.assertCurrent();
        return true;
      },
    });
    if (!view) {
      throw new Error("MCP App resource could not be loaded");
    }
    const preview = buildMcpAppCanvasPayload({ ...view, originSessionKey: active.sessionKey });
    active.assertCurrent();
    const lease = getMcpAppViewLease(view.viewId, viewRuntime);
    if (lease) {
      lease.disposeCallbacks ??= new Set();
      lease.disposeCallbacks.add(retained.release);
      transferred = true;
    }
    return { viewId: view.viewId, preview };
  } finally {
    if (!transferred) {
      retained.release();
    }
  }
}
function handler<T>(
  schema: z.ZodType<T>,
  operation: (active: Prepared, params: T) => unknown,
  disabledResult?: McpAppDiscoverResult,
): GatewayRequestHandler {
  return async (options) => {
    let active: Prepared | undefined;
    try {
      const params = schema.parse(options.params);
      if (disabledResult && options.context.getRuntimeConfig().mcp?.apps?.enabled !== true) {
        options.sessionAccessAuthority?.assertCurrent();
        options.respond(true, disabledResult);
        return;
      }
      await runWithSessionMcpRequestSignal(options.signal, async () => {
        active = await prepareMcpAppExtensionRuntime(options);
        const result = await operation(active, params);
        active.assertCurrent();
        options.respond(true, result);
      });
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          error instanceof z.ZodError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      await active
        ?.dispose()
        .catch((error: unknown) => logWarn(`mcp-app: cleanup failed: ${String(error)}`));
    }
  };
}
export const mcpAppExtensionHandlers: GatewayRequestHandlers = {
  "mcp.app.discover": handler(
    targetSchema,
    (active): McpAppDiscoverResult => ({
      onboarding: (() => {
        const metadata = getGatewayPluginMetadataSnapshot();
        return metadata
          ? [
              ...iteratePluginRootContributions({
                metadataSnapshot: metadata,
                config: active.options.context.getRuntimeConfig(),
                contribution: "skills",
              }),
            ].flatMap(({ record }) =>
              record.onboardingSkill
                ? [{ pluginId: record.id, title: record.name ?? record.id }]
                : [],
            )
          : [];
      })(),
      servers: Object.values(active.catalog.servers).flatMap((server) => {
        const install = server.pluginId
          ? getGatewayPluginMetadataSnapshot()?.index.installRecords[server.pluginId]
          : undefined;
        const pluginId = install?.marketplacePlugin ?? server.pluginId;
        const marketplace = install?.marketplaceName ?? server.marketplace;
        const tools = active.catalog.tools.filter((tool) => tool.serverName === server.serverName);
        const entrypoints = tools.flatMap((tool) =>
          tool.uiResourceUri?.startsWith("ui://")
            ? (tool.appExtensions?.entrypoints ?? []).map((entrypoint) => ({
                toolName: tool.toolName,
                title: tool.title ?? tool.toolName,
                resourceUri: tool.uiResourceUri!,
                icons: tool.appExtensions?.icons ?? server.icons,
                entrypoint,
              }))
            : [],
        );
        const settings =
          server.settings &&
          tools.some((tool) => tool.toolName === server.settings?.readTool) &&
          tools.some((tool) => tool.toolName === server.settings?.updateTool)
            ? server.settings
            : undefined;
        const mentionTool = tools.find((tool) => tool.appExtensions?.mentionSearch)?.toolName;
        return entrypoints.length || settings || mentionTool
          ? [
              {
                serverName: server.serverName,
                ...(pluginId ? { pluginId } : {}),
                ...(marketplace ? { marketplace } : {}),
                label: server.title ?? server.serverName,
                icons: server.icons,
                entrypoints,
                ...(settings ? { settings } : {}),
                ...(mentionTool ? { mentionTool } : {}),
              },
            ]
          : [];
      }),
    }),
    { servers: [], onboarding: [] },
  ),
  "mcp.app.launch": handler(launchSchema, async (active, params) => {
    const tool = toolFor(active, params.serverName, params.toolName);
    const entrypoint = tool.appExtensions?.entrypoints?.find(
      (entry) => entry.type === params.entrypointType,
    );
    if (!entrypoint) {
      throw new Error("The requested MCP App entrypoint is not advertised");
    }
    if (params.quickAction) {
      if (entrypoint.type !== "global" || !entrypoint.quickAction) {
        throw new Error("MCP App quick action is unavailable");
      }
      const action = entrypoint.quickAction.target;
      const actionTool = toolFor(active, params.serverName, action.name);
      return actionTool.uiResourceUri
        ? launch(active, actionTool, action.arguments ?? {})
        : { toolResult: await call(active, actionTool, action.arguments ?? {}) };
    }
    if (entrypoint.type === "file") {
      if (!params.filePath) {
        throw new Error("Choose a session file to open");
      }
      const hostFile = await prepareMcpAppHostFile(active.options, {
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        path: params.filePath,
      });
      active.assertCurrent();
      if (
        !entrypoint.extensions.some((extension) =>
          hostFile.name.toLowerCase().endsWith(extension.toLowerCase()),
        )
      ) {
        throw new Error("The file extension is not supported by this App");
      }
      return await launch(
        active,
        tool,
        { file: { name: hostFile.name, resourceUri: hostFile.resourceUri } },
        { hostFile },
      );
    }
    if (
      params.deepLink &&
      (entrypoint.type !== "global" ||
        !params.deepLink.startsWith("/") ||
        params.deepLink.startsWith("//") ||
        params.deepLink.includes("#"))
    ) {
      throw new Error("Invalid App-relative deep link");
    }
    return await launch(
      active,
      tool,
      {},
      params.deepLink ? { deepLink: { url: params.deepLink } } : undefined,
    );
  }),
  "mcp.app.settings": handler(settingsSchema, async (active, params) => {
    const capability = active.catalog.servers[params.serverName]?.settings;
    if (!capability) {
      throw new Error("Structured MCP settings are unavailable");
    }
    if (params.action === "update") {
      if (!params.arguments) {
        throw new Error("Changed settings are required");
      }
      return {
        toolResult: await call(
          active,
          toolFor(active, params.serverName, capability.updateTool),
          params.arguments,
        ),
      };
    }
    const result = await call(active, toolFor(active, params.serverName, capability.readTool), {});
    if (result.isError) {
      throw new Error("The MCP settings read tool failed");
    }
    const settings = readMcpAppSettings(result.structuredContent);
    if (params.action === "read") {
      return settings;
    }
    if (
      !settings.layout?.some((group) =>
        group.items.some((item) => item.kind === "tool" && item.tool === params.toolName),
      )
    ) {
      throw new Error("Settings action is not advertised in the current layout");
    }
    const tool = toolFor(active, params.serverName, params.toolName!);
    return tool.uiResourceUri
      ? launch(active, tool, {})
      : { toolResult: await call(active, tool, {}) };
  }),
  "mcp.app.mention": handler(mentionSchema, async (active, params) => {
    const tool = active.catalog.tools.find(
      (candidate) =>
        candidate.serverName === params.serverName && candidate.appExtensions?.mentionSearch,
    );
    if (!tool) {
      throw new Error("MCP mention search is unavailable");
    }
    const result = await call(active, tool, { query: params.query });
    if (result.isError) {
      throw new Error("MCP mention search failed");
    }
    const resources = z
      .array(ResourceLinkSchema)
      .max(200)
      .parse(asOptionalRecord(result.structuredContent)?.items);
    return { resources };
  }),
};
