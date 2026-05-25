import { describe, expect, it } from "vitest";
import { resolveOpenClawToolsForMcp } from "./openclaw-tools-serve.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

describe("OpenClaw tools MCP server", () => {
  it("exposes cron", async () => {
    const handlers = createPluginToolsMcpHandlers(resolveOpenClawToolsForMcp());

    const listed = await handlers.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("cron");
  });

  it("exposes the slack action bridge so harnesses can call channel actions", async () => {
    const handlers = createPluginToolsMcpHandlers(resolveOpenClawToolsForMcp());
    const listed = await handlers.listTools();
    const slack = listed.tools.find((tool) => tool.name === "slack");
    expect(slack).toBeDefined();

    const schema = slack?.inputSchema as { properties?: Record<string, unknown> };
    const action = schema.properties?.action as { enum?: unknown[] } | undefined;
    expect(action?.enum).toEqual(
      expect.arrayContaining([
        "react",
        "reactions",
        "sendMessage",
        "editMessage",
        "deleteMessage",
        "readMessages",
        "pinMessage",
        "unpinMessage",
        "listPins",
        "memberInfo",
        "emojiList",
        "uploadFile",
        "downloadFile",
      ]),
    );
  });
});
