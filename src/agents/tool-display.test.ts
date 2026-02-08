import { describe, expect, it } from "vitest";
import { formatToolDetail, formatToolSummary, resolveToolDisplay } from "./tool-display.js";

describe("tool display details", () => {
  it("skips zero/false values for optional detail fields", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: {
          task: "double-message-bug-gpt",
          label: 0,
          runTimeoutSeconds: 0,
          timeoutSeconds: 0,
        },
      }),
    );

    expect(detail).toBe("double-message-bug-gpt");
  });

  it("includes only truthy boolean details", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "message",
        args: {
          action: "react",
          provider: "discord",
          to: "chan-1",
          remove: false,
        },
      }),
    );

    expect(detail).toContain("provider discord");
    expect(detail).toContain("to chan-1");
    expect(detail).not.toContain("remove");
  });

  it("keeps positive numbers and true booleans", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_history",
        args: {
          sessionKey: "agent:main:main",
          limit: 20,
          includeTools: true,
        },
      }),
    );

    expect(detail).toContain("session agent:main:main");
    expect(detail).toContain("limit 20");
    expect(detail).toContain("tools true");
  });
});

describe("tool display file_path alias (#10059)", () => {
  it("resolves read detail when args use file_path instead of path", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { file_path: "src/agents/tool-display.ts" },
    });

    expect(display.detail).toBe("src/agents/tool-display.ts");
  });

  it("resolves read detail with file_path + offset + limit", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { file_path: "src/foo.ts", offset: 10, limit: 20 },
    });

    expect(display.detail).toBe("src/foo.ts:10-30");
  });

  it("resolves write detail when args use file_path instead of path", () => {
    const display = resolveToolDisplay({
      name: "write",
      args: { file_path: "src/bar.ts", content: "hello" },
    });

    expect(display.detail).toBe("src/bar.ts");
  });

  it("resolves edit detail when args use file_path instead of path", () => {
    const display = resolveToolDisplay({
      name: "edit",
      args: { file_path: "src/baz.ts", oldText: "a", newText: "b" },
    });

    expect(display.detail).toBe("src/baz.ts");
  });

  it("resolves attach detail when args use file_path instead of path", () => {
    const display = resolveToolDisplay({
      name: "attach",
      args: { file_path: "docs/readme.md" },
    });

    expect(display.detail).toBe("docs/readme.md");
  });

  it("prefers path over file_path when both are present", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { path: "preferred.ts", file_path: "ignored.ts" },
    });

    expect(display.detail).toBe("preferred.ts");
  });

  it("formats full verbose summary with file_path", () => {
    const summary = formatToolSummary(
      resolveToolDisplay({
        name: "read",
        args: { file_path: "src/agents/tool-display.ts" },
      }),
    );

    expect(summary).toContain("src/agents/tool-display.ts");
  });
});
