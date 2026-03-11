import { describe, expect, it } from "vitest";
import {
  formatJsonPath,
  resolveJson5BreadcrumbsAt,
  resolveJson5PathAt,
} from "./config-raw-editor-path.ts";
import "./config-raw-editor.ts";

describe("config raw editor", () => {
  it("tracks cursor position in the raw editor status bar", async () => {
    const editor = document.createElement("config-raw-editor");
    editor.value = '{\n  gateway: {\n    mode: "local"\n  }\n}\n';
    document.body.append(editor);

    await editor.updateComplete;

    const status = editor.shadowRoot?.querySelector(".status");
    expect(status?.textContent).toContain("Line 1 Col 1");
    expect(status?.textContent).toContain("|");
    expect(status?.textContent).toContain("Path");
    expect(status?.textContent).toContain("Root");

    editor.setSelection(5);
    await editor.updateComplete;

    expect(status?.textContent).toContain("Line 2 Col 4");
    expect(status?.textContent).toContain("Path");
    expect(status?.textContent).toContain("gateway");

    editor.remove();
  });

  it("resolves nested JSON5 paths at the cursor", () => {
    const raw = `{
  // comment
  secrets: {
    providers: {
      openai: {
        apiKey: '<redacted>'
      }
    }
  }
}
`;
    const offset = raw.indexOf("apiKey");
    expect(formatJsonPath(resolveJson5PathAt(raw, offset))).toBe(
      "secrets > providers > openai > apiKey",
    );
  });

  it("resolves object keys and values when a JSON5 comment appears before the colon", () => {
    const raw = `{
  foo /* note */: 1
}
`;
    const keyOffset = raw.indexOf("foo");
    const valueOffset = raw.indexOf("1");
    expect(formatJsonPath(resolveJson5PathAt(raw, keyOffset))).toBe("foo");
    expect(formatJsonPath(resolveJson5PathAt(raw, valueOffset))).toBe("foo");
  });

  it("resolves non-ascii unquoted JSON5 keys", () => {
    const raw = `{
  名称: 1
}
`;
    const keyOffset = raw.indexOf("名");
    const valueOffset = raw.indexOf("1");
    expect(formatJsonPath(resolveJson5PathAt(raw, keyOffset))).toBe("名称");
    expect(formatJsonPath(resolveJson5PathAt(raw, valueOffset))).toBe("名称");
  });

  it("tracks array indexes in JSON5 paths", () => {
    const raw = `{
  tools: [
    { name: "a" },
    { name: "b" }
  ]
}
`;
    const offset = raw.lastIndexOf('name: "b"');
    expect(formatJsonPath(resolveJson5PathAt(raw, offset))).toBe("tools > [1] > name");
  });

  it("keeps array breadcrumbs structured between values", () => {
    const raw = `[
  1,
  2
]
`;
    const offset = raw.indexOf("2") - 1;
    const breadcrumbs = resolveJson5BreadcrumbsAt(raw, offset);
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toEqual({
      segment: 1,
      from: raw.indexOf(",") + 1,
    });
    expect(formatJsonPath(resolveJson5PathAt(raw, offset))).toBe("[1]");
  });

  it("returns breadcrumb positions for nested keys", () => {
    const raw = `{
  plugins: {
    entries: {
      "feishu-greeting": {
        config: {
          message: "hi"
        }
      }
    }
  }
}
`;
    const offset = raw.indexOf("message");
    const breadcrumbs = resolveJson5BreadcrumbsAt(raw, offset);
    expect(breadcrumbs.map((entry) => entry.segment)).toEqual([
      "plugins",
      "entries",
      "feishu-greeting",
      "config",
      "message",
    ]);
    expect(raw.slice(breadcrumbs[1]?.from ?? 0, (breadcrumbs[1]?.from ?? 0) + 7)).toBe("entries");
  });

  it("renders array index breadcrumbs between values without blank labels", async () => {
    const editor = document.createElement("config-raw-editor");
    editor.value = `[
  1,
  2
]
`;
    document.body.append(editor);
    await editor.updateComplete;

    editor.setSelection(editor.value.indexOf("2") - 1);
    await editor.updateComplete;

    const buttons = Array.from(
      editor.shadowRoot?.querySelectorAll<HTMLButtonElement>(".status__path-btn") ?? [],
    );
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["[1]"]);

    buttons[0]?.click();
    await editor.updateComplete;

    const status = editor.shadowRoot?.querySelector(".status");
    expect(status?.textContent).toContain("Path");
    expect(status?.textContent).toContain("[1]");

    editor.remove();
  });

  it("jumps to the clicked path segment", async () => {
    const editor = document.createElement("config-raw-editor");
    editor.value = `{
  plugins: {
    entries: {
      "feishu-greeting": {
        config: {
          message: "hi"
        }
      }
    }
  }
}
`;
    document.body.append(editor);
    await editor.updateComplete;

    editor.setSelection(editor.value.indexOf("message"));
    await editor.updateComplete;

    const buttons = Array.from(
      editor.shadowRoot?.querySelectorAll<HTMLButtonElement>(".status__path-btn") ?? [],
    );
    const target = buttons.find((button) => button.textContent?.trim() === "entries");
    target?.click();
    await editor.updateComplete;

    const status = editor.shadowRoot?.querySelector(".status");
    expect(status?.textContent).toContain("Path");
    expect(status?.textContent).toContain("plugins");
    expect(status?.textContent).toContain("entries");
    expect(status?.textContent).not.toContain("message");

    editor.remove();
  });
});
