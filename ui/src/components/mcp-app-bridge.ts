import {
  specTypeSchemas,
  type StandardSchemaV1Sync,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/client";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { ApplicationContext } from "../app/context.ts";
import {
  isWidgetFrameInteractable,
  MCP_APP_FILE_OPEN_EVENT,
  type McpAppFileOpenEventDetail,
} from "./mcp-app-security.ts";

const extensionRecordSchema = z.record(z.string(), z.unknown());
const fileOpenResultSchema = z.object({ path: z.string(), name: z.string() });

/** Validate unknown Gateway responses against the installed SDK contract without dropping metadata. */
function requireMcpResult<T>(schema: StandardSchemaV1Sync<unknown, T>, value: unknown): T {
  const result = schema["~standard"].validate(value);
  if (result.issues) {
    throw new Error("Invalid Gateway MCP result");
  }
  return result.value;
}

export class OpenClawAppBridge extends AppBridge {
  setMessageHandler(
    handler: (
      params: Parameters<NonNullable<AppBridge["onmessage"]>>[0] & {
        _meta?: Record<string, unknown>;
      },
      extra: Parameters<NonNullable<AppBridge["onmessage"]>>[1],
    ) => ReturnType<NonNullable<AppBridge["onmessage"]>>,
  ) {
    const wrapped: NonNullable<AppBridge["onmessage"]> = (params, extra) =>
      handler({ ...params, _meta: extra?.mcpReq?._meta }, extra);
    Reflect.set(this, "onmessage", wrapped);
  }

  setUpdateModelContextHandler(handler: NonNullable<AppBridge["onupdatemodelcontext"]>) {
    Reflect.set(this, "onupdatemodelcontext", handler);
  }

  setHostRequestHandler(
    method:
      | "openai/resources/write"
      | "resources/subscribe"
      | "resources/unsubscribe"
      | "openai/files/open",
    handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    this.replaceRequestHandler(
      method,
      { params: extensionRecordSchema, result: extensionRecordSchema },
      handler,
    );
  }

  setListToolsHandler(handler: (params: ListToolsRequest["params"]) => Promise<ListToolsResult>) {
    this.replaceRequestHandler("tools/list", (request) => handler(request.params));
  }
}

export function bindMcpAppResourceHandlers(owner: {
  bridge: OpenClawAppBridge;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  sessionKey: string;
  viewId: string;
  agentId?: string;
  iframe: HTMLIFrameElement;
  fileResourcesSupported?: boolean;
  openFilesSupported?: boolean;
  confirmOpenFile: (path: string) => Promise<boolean>;
  isDisposed: () => boolean;
  addCleanup: (cleanup: () => void) => void;
  dispatchEvent: (event: Event) => boolean;
  onModelContextChanged: (clearedUpdateId?: string) => void;
  onConversationInputRequested: () => void;
  subscribeEvents: (
    listener: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0],
  ) => (() => void) | undefined;
}): () => void {
  const { bridge, request, sessionKey, viewId, iframe } = owner;
  bridge.oncalltool = async (params) =>
    requireMcpResult(
      specTypeSchemas.CallToolResult,
      await request("mcp.app.callTool", {
        toolName: params.name,
        arguments: params.arguments,
      }),
    );
  bridge.setListToolsHandler(async (params) =>
    requireMcpResult(
      specTypeSchemas.ListToolsResult,
      await request("mcp.app.listTools", params?.cursor ? { cursor: params.cursor } : {}),
    ),
  );
  bridge.onlistresources = async (params) =>
    requireMcpResult(
      specTypeSchemas.ListResourcesResult,
      await request("mcp.app.listResources", params?.cursor ? { cursor: params.cursor } : {}),
    );
  bridge.onlistresourcetemplates = async (params) =>
    requireMcpResult(
      specTypeSchemas.ListResourceTemplatesResult,
      await request(
        "mcp.app.listResourceTemplates",
        params?.cursor ? { cursor: params.cursor } : {},
      ),
    );
  bridge.onreadresource = async (params, extra) =>
    requireMcpResult(
      specTypeSchemas.ReadResourceResult,
      await request("mcp.app.readResource", {
        uri: params.uri,
        _meta: extra.mcpReq._meta ?? params._meta,
      }),
    );
  const resourceSubscriptions = new Set<string>();
  if (owner.fileResourcesSupported) {
    bridge.setHostRequestHandler("openai/resources/write", async (params) =>
      extensionRecordSchema.parse(await request("mcp.app.writeResource", params)),
    );
    bridge.setHostRequestHandler("resources/subscribe", async (params) => {
      const result = extensionRecordSchema.parse(
        await request("mcp.app.subscribeResource", params),
      );
      if (typeof params.uri === "string") {
        if (owner.isDisposed()) {
          await request("mcp.app.unsubscribeResource", { uri: params.uri });
        } else {
          resourceSubscriptions.add(params.uri);
        }
      }
      return result;
    });
    bridge.setHostRequestHandler("resources/unsubscribe", async (params) => {
      const result = extensionRecordSchema.parse(
        await request("mcp.app.unsubscribeResource", params),
      );
      if (typeof params.uri === "string") {
        resourceSubscriptions.delete(params.uri);
      }
      return result;
    });
    owner.addCleanup(() => {
      for (const uri of resourceSubscriptions) {
        void request("mcp.app.unsubscribeResource", { uri }).catch(() => undefined);
      }
      resourceSubscriptions.clear();
    });
  }
  if (owner.openFilesSupported) {
    bridge.setHostRequestHandler("openai/files/open", async (params) => {
      if (
        owner.isDisposed() ||
        !isWidgetFrameInteractable(iframe) ||
        typeof params.path !== "string" ||
        !(await owner.confirmOpenFile(params.path)) ||
        owner.isDisposed() ||
        !isWidgetFrameInteractable(iframe)
      ) {
        return { isError: true };
      }
      const file = fileOpenResultSchema.parse(await request("mcp.app.openFile", params));
      if (owner.isDisposed()) {
        return { isError: true };
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        const accepted = !owner.dispatchEvent(
          new CustomEvent<McpAppFileOpenEventDetail>(MCP_APP_FILE_OPEN_EVENT, {
            bubbles: true,
            composed: true,
            cancelable: true,
            detail: {
              sessionKey,
              viewId,
              ...file,
              respond: (ok) => resolve(ok ? {} : { isError: true }),
            },
          }),
        );
        if (!accepted) {
          resolve({ isError: true });
        }
      });
    });
  }

  // The view starts notifications only after the App initialization handshake.
  return () => {
    const stopEvents = owner.subscribeEvents((event) => {
      if (owner.isDisposed()) {
        return;
      }
      const value = asOptionalRecord(event.payload);
      const input =
        event.event === "question.requested" && value?.status === "pending"
          ? value
          : event.event === "plugin.approval.requested"
            ? asOptionalRecord(value?.request)
            : undefined;
      if (
        input?.sessionKey === sessionKey &&
        (!owner.agentId || !input.agentId || input.agentId === owner.agentId)
      ) {
        owner.onConversationInputRequested();
      }
      if (value?.viewId !== viewId) {
        return;
      }
      if (event.event === "mcp.app.hostContextChanged") {
        owner.onModelContextChanged(
          value.modelContext === null && typeof value.updateId === "string"
            ? value.updateId
            : undefined,
        );
      }
      if (
        event.event === "mcp.app.resourceUpdated" &&
        typeof value.uri === "string" &&
        resourceSubscriptions.has(value.uri)
      ) {
        void bridge.notification({
          method: "notifications/resources/updated",
          params: { uri: value.uri },
        });
      }
    });
    if (stopEvents) {
      owner.addCleanup(stopEvents);
    }
  };
}
