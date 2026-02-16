import { describe, expect, it } from "vitest";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

describe("tool display details", () => {
  it("skips zero/false values for optional detail fields", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: {
          task: "double-message-bug-gpt",
          label: 0,
          runTimeoutSeconds: 0,
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

  it("formats read/write/edit with intent-first file detail", () => {
    const readDetail = formatToolDetail(
      resolveToolDisplay({
        name: "read",
        args: { file_path: "/tmp/a.txt", offset: 2, limit: 2 },
      }),
    );
    const writeDetail = formatToolDetail(
      resolveToolDisplay({
        name: "write",
        args: { file_path: "/tmp/a.txt", content: "abc" },
      }),
    );
    const editDetail = formatToolDetail(
      resolveToolDisplay({
        name: "edit",
        args: { path: "/tmp/a.txt", newText: "abcd" },
      }),
    );

    expect(readDetail).toBe("lines 2-3 from /tmp/a.txt");
    expect(writeDetail).toBe("to /tmp/a.txt (3 chars)");
    expect(editDetail).toBe("in /tmp/a.txt (4 chars)");
  });

  it("formats web_search query with quotes", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "web_search",
        args: { query: "OpenClaw docs", count: 3 },
      }),
    );

    expect(detail).toBe('for "OpenClaw docs" (top 3)');
  });

  it("summarizes exec commands with context", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command:
            "set -euo pipefail\ngit -C /Users/adityasingh/.openclaw/workspace status --short | head -n 3",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );

    expect(detail).toContain("check git status -> show first 3 lines");
    expect(detail).toContain(".openclaw/workspace)");
  });

  it("recognizes heredoc/inline script exec details", () => {
    const pyDetail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command: "python3 <<PY\nprint('x')\nPY",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );
    const nodeCheckDetail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: {
          command: "node --check /tmp/test.js",
          workdir: "/Users/adityasingh/.openclaw/workspace",
        },
      }),
    );

    expect(pyDetail).toContain("run python3 inline script (heredoc)");
    expect(nodeCheckDetail).toContain("check js syntax for /tmp/test.js");
  });
});
