import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

type SessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  message?: unknown;
  summary?: string;
  content?: unknown;
  display?: boolean;
  customType?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
};

type SessionData = {
  header: { id: string; timestamp: string };
  entries: SessionEntry[];
  leafId: string;
  systemPrompt: string;
  tools: unknown[];
};

const exportHtmlDir = path.dirname(fileURLToPath(import.meta.url));
const templateHtml = fs.readFileSync(path.join(exportHtmlDir, "template.html"), "utf8");
const templateJs = fs.readFileSync(path.join(exportHtmlDir, "template.js"), "utf8");
const markedJs = fs.readFileSync(path.join(exportHtmlDir, "vendor", "marked.min.js"), "utf8");
const highlightJs = fs.readFileSync(path.join(exportHtmlDir, "vendor", "highlight.min.js"), "utf8");

function renderTemplate(sessionData: SessionData) {
  const html = templateHtml
    .replace("{{CSS}}", "")
    .replace("{{SESSION_DATA}}", Buffer.from(JSON.stringify(sessionData), "utf8").toString("base64"))
    .replace("{{MARKED_JS}}", "")
    .replace("{{HIGHLIGHT_JS}}", "")
    .replace("{{JS}}", "");

  const { document, window } = parseHTML(html);
  if (window.HTMLElement?.prototype) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }

  const immediateTimeout = (fn: (...args: unknown[]) => void) => {
    fn();
    return 0;
  };
  const runtime: Record<string, unknown> = {
    document,
    console,
    clearTimeout: () => {},
    setTimeout: immediateTimeout,
    URLSearchParams,
    TextDecoder,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState: () => {} },
    location: { href: "http://localhost/export.html", search: "" },
  };
  runtime.window = runtime;
  runtime.self = runtime;
  runtime.globalThis = runtime;

  vm.createContext(runtime);
  vm.runInContext(markedJs, runtime);
  vm.runInContext(highlightJs, runtime);
  vm.runInContext(templateJs, runtime);
  return { document };
}

function now() {
  return new Date("2026-02-24T00:00:00.000Z").toISOString();
}

describe("export html security hardening", () => {
  it("escapes raw HTML from markdown blocks", () => {
    const attack = "<img src=x onerror=alert(1)>";
    const session: SessionData = {
      header: { id: "session-1", timestamp: now() },
      entries: [
        {
          id: "1",
          parentId: null,
          timestamp: now(),
          type: "message",
          message: { role: "user", content: attack },
        },
        {
          id: "2",
          parentId: "1",
          timestamp: now(),
          type: "branch_summary",
          summary: attack,
        },
        {
          id: "3",
          parentId: "2",
          timestamp: now(),
          type: "custom_message",
          customType: "x",
          display: true,
          content: attack,
        },
      ],
      leafId: "3",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(session);
    const messages = document.getElementById("messages");
    expect(messages).toBeTruthy();
    expect(messages?.querySelector("img[onerror]")).toBeNull();
    expect(messages?.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes tree and header metadata fields", () => {
    const attack = "<img src=x onerror=alert(9)>";
    const baseEntries: SessionEntry[] = [
      {
        id: "1",
        parentId: null,
        timestamp: now(),
        type: "message",
        message: { role: "user", content: "ok" },
      },
      {
        id: "2",
        parentId: "1",
        timestamp: now(),
        type: "message",
        message: {
          role: "assistant",
          model: attack,
          provider: "p",
          content: [{ type: "text", text: "assistant" }],
        },
      },
      {
        id: "3",
        parentId: "2",
        timestamp: now(),
        type: "message",
        message: { role: "toolResult", toolName: attack },
      },
      {
        id: "4",
        parentId: "3",
        timestamp: now(),
        type: "model_change",
        provider: "p",
        modelId: attack,
      },
      {
        id: "5",
        parentId: "4",
        timestamp: now(),
        type: "thinking_level_change",
        thinkingLevel: attack,
      },
      {
        id: "6",
        parentId: "5",
        timestamp: now(),
        type: attack,
      },
    ];

    const headerSession: SessionData = {
      header: { id: "session-2", timestamp: now() },
      entries: baseEntries,
      leafId: "6",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(headerSession);
    const tree = document.getElementById("tree-container");
    const header = document.getElementById("header-container");
    expect(tree).toBeTruthy();
    expect(header).toBeTruthy();
    expect(tree?.querySelector("img[onerror]")).toBeNull();
    expect(header?.querySelector("img[onerror]")).toBeNull();
    expect(tree?.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");
    expect(header?.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");

    const modelLeafSession: SessionData = {
      header: { id: "session-2-model", timestamp: now() },
      entries: baseEntries,
      leafId: "4",
      systemPrompt: "",
      tools: [],
    };
    const modelLeaf = renderTemplate(modelLeafSession).document;
    expect(modelLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(modelLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );

    const thinkingLeafSession: SessionData = {
      header: { id: "session-2-thinking", timestamp: now() },
      entries: baseEntries,
      leafId: "5",
      systemPrompt: "",
      tools: [],
    };
    const thinkingLeaf = renderTemplate(thinkingLeafSession).document;
    expect(thinkingLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(thinkingLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );
  });

  it("sanitizes image MIME types used in data URLs", () => {
    const session: SessionData = {
      header: { id: "session-3", timestamp: now() },
      entries: [
        {
          id: "1",
          parentId: null,
          timestamp: now(),
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "image",
                data: "AAAA",
                mimeType: 'image/png" onerror="alert(7)',
              },
            ],
          },
        },
      ],
      leafId: "1",
      systemPrompt: "",
      tools: [],
    };

    const { document } = renderTemplate(session);
    const img = document.querySelector("#messages .message-image");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(img?.getAttribute("src")).toBe("data:application/octet-stream;base64,AAAA");
  });
});
