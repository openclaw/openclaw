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

describe("resolveToolDisplay file_path fallback", () => {
  it("uses file_path when path is absent for read tools", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { file_path: "/tmp/foo.txt" },
    });
    expect(display.detail).toContain("/tmp/foo.txt");
  });

  it("uses file_path with offset and limit for read tools", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { file_path: "/tmp/bar.ts", offset: 10, limit: 20 },
    });
    expect(display.detail).toBe("/tmp/bar.ts:10-30");
  });

  it("uses file_path when path is absent for write tools", () => {
    const display = resolveToolDisplay({
      name: "write",
      args: { file_path: "/tmp/out.txt", content: "hello" },
    });
    expect(display.detail).toContain("/tmp/out.txt");
  });

  it("prefers path over file_path", () => {
    const display = resolveToolDisplay({
      name: "read",
      args: { path: "/preferred.txt", file_path: "/fallback.txt" },
    });
    expect(display.detail).toContain("/preferred.txt");
  });
});
