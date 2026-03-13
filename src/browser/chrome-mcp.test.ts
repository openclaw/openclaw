import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listChromeMcpTabs,
  openChromeMcpTab,
  resetChromeMcpSessionsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

function createFakeSession() {
  const callTool = vi.fn(async ({ name }: ToolCall) => {
    if (name === "list_pages") {
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session [selected]",
              "2: https://github.com/openclaw/openclaw/pull/45318",
            ].join("\n"),
          },
        ],
      };
    }
    if (name === "new_page") {
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
              "2: https://github.com/openclaw/openclaw/pull/45318",
              "3: https://example.com/ [selected]",
            ].join("\n"),
          },
        ],
      };
    }
    throw new Error(`unexpected tool ${name}`);
  });

  return {
    client: {
      callTool,
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    },
    transport: {
      pid: 123,
    },
    ready: Promise.resolve(),
  };
}

describe("chrome MCP page parsing", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
  });

  it("parses list_pages text responses when structuredContent is missing", async () => {
    setChromeMcpSessionFactoryForTest(async () => createFakeSession());

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(tabs).toEqual([
      {
        targetId: "1",
        title: "",
        url: "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
        type: "page",
      },
      {
        targetId: "2",
        title: "",
        url: "https://github.com/openclaw/openclaw/pull/45318",
        type: "page",
      },
    ]);
  });

  it("parses new_page text responses and returns the created tab", async () => {
    setChromeMcpSessionFactoryForTest(async () => createFakeSession());

    const tab = await openChromeMcpTab("chrome-live", "https://example.com/");

    expect(tab).toEqual({
      targetId: "3",
      title: "",
      url: "https://example.com/",
      type: "page",
    });
  });
});
