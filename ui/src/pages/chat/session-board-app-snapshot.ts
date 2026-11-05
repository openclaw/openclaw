import { specTypeSchemas } from "@modelcontextprotocol/client";
import type { BoardWidget } from "@openclaw/gateway-protocol";
import type { McpAppViewPayload } from "../../components/mcp-app-view-types.ts";
import * as json from "../../lib/snapshot-json.ts";
import { accessSnapshotProjection } from "./session-sidebar-snapshot.ts";
import { BOARD_APP_SNAPSHOT_STORE_NAME } from "./session-snapshot-database.ts";

export const boardAppDisplaySchema = json.object({
  html: json.text,
  csp: json.optional(json.record(json.array(json.text))),
  sandboxUrl: json.text,
  sandboxPort: json.number,
  sandboxOrigin: json.optional(json.text),
  messageSupported: json.optional(json.boolean),
  updateModelContextSupported: json.optional(json.boolean),
  richModelContextSupported: json.optional(json.boolean),
  fileResourcesSupported: json.optional(json.boolean),
  openFilesSupported: json.optional(json.boolean),
  displayMode: json.optional(json.enumeration(["inline", "fullscreen"])),
  displayModes: json.optional(
    json.object({
      availableDisplayModes: json.optional(json.array(json.enumeration(["inline", "fullscreen"]))),
      preferredDisplayMode: json.optional(json.enumeration(["inline", "fullscreen"])),
    }),
  ),
  toolInput: json.unknown,
  toolResult: {
    parse(value: unknown): McpAppViewPayload["toolResult"] {
      const result = specTypeSchemas.CallToolResult["~standard"].validate(value);
      if (result.issues) throw new TypeError("Invalid cached App result");
      const { content, structuredContent, isError, _meta } = result.value;
      return { content, structuredContent, isError, _meta };
    },
  },
});
export type BoardAppDisplay = json.SnapshotValue<typeof boardAppDisplaySchema>;
export const boardAppDisplayKey = (widget: BoardWidget) =>
  JSON.stringify([widget.name, widget.instanceId, widget.revision, widget.grantState]);

export async function accessBoardAppSnapshot(
  sessionKey: string,
  widgets: readonly BoardWidget[],
  isCurrent: () => boolean,
  widget?: BoardWidget,
  payload?: McpAppViewPayload,
): Promise<BoardAppDisplay | null> {
  const prefix = `${sessionKey}\0board:`;
  const key = widget ? prefix + boardAppDisplayKey(widget) : prefix;
  const valid = new Set(
    widgets
      .filter(
        (item) =>
          item.contentKind === "mcp-app" &&
          item.grantState !== "pending" &&
          item.grantState !== "rejected",
      )
      .map((item) => prefix + boardAppDisplayKey(item)),
  );
  return accessSnapshotProjection(
    key,
    (value) => json.parseSnapshot(boardAppDisplaySchema, value),
    isCurrent,
    payload && valid.has(key)
      ? {
          sessionKey: key,
          savedAt: Date.now(),
          projectionVersion: 1,
          model: boardAppDisplaySchema.parse(payload),
        }
      : undefined,
    {
      storeName: BOARD_APP_SNAPSHOT_STORE_NAME,
      projectionVersion: 1,
      maxBytes: 4 * 1024 * 1024,
      retain: (record) => !record.sessionKey.startsWith(prefix) || valid.has(record.sessionKey),
    },
  );
}
