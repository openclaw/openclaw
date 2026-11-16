import { describe, expect, it } from "vitest";
import {
  readWorkspaceFileText,
  workspaceBrowserFilePath,
  workspaceFileCopyPath,
} from "./chat-session-workspace-file-content.ts";

describe("workspaceBrowserFilePath", () => {
  it("joins a POSIX root with a relative file path", () => {
    expect(workspaceBrowserFilePath("/home/user/workspace", "notes/a.txt")).toBe(
      "/home/user/workspace/notes/a.txt",
    );
  });

  it("trims trailing slash from the root before joining", () => {
    expect(workspaceBrowserFilePath("/home/user/workspace/", "a.txt")).toBe(
      "/home/user/workspace/a.txt",
    );
  });

  it("handles nested sub-paths", () => {
    expect(workspaceBrowserFilePath("/ws", "a/b/c.webp")).toBe("/ws/a/b/c.webp");
  });

  it("preserves Windows backslash separators in the root", () => {
    expect(workspaceBrowserFilePath("C:\\work", "file.png")).toBe("C:\\work\\file.png");
  });

  it("returns the path unchanged when root is undefined", () => {
    expect(workspaceBrowserFilePath(undefined, "a.txt")).toBe("a.txt");
  });

  it("returns the path unchanged when the path is already absolute (POSIX)", () => {
    expect(workspaceBrowserFilePath("/ws", "/etc/hosts")).toBe("/etc/hosts");
  });

  it("returns the path unchanged when the path is already absolute (Windows drive)", () => {
    expect(workspaceBrowserFilePath("/ws", "C:\\ws\\f.txt")).toBe("C:\\ws\\f.txt");
  });

  it("returns the path unchanged when the path is a UNC share", () => {
    expect(workspaceBrowserFilePath("/ws", "\\\\server\\share\\f.txt")).toBe("\\\\server\\share\\f.txt");
  });

  it("handles a root with backslashes but also a forward-slash file path", () => {
    // root has backslashes and no forward slash → separator is backslash
    expect(workspaceBrowserFilePath("C:\\ws", "a\\b.png")).toBe("C:\\ws\\a\\b.png");
  });
});

describe("workspaceFileCopyPath", () => {
  it("returns the absolute workspace path when origin is workspace", () => {
    expect(workspaceFileCopyPath("/home/u/ws", "workspace", "a.txt")).toBe(
      "/home/u/ws/a.txt",
    );
  });

  it("returns the raw path when origin is session", () => {
    expect(workspaceFileCopyPath("/home/u/ws", "session", "a.txt")).toBe("a.txt");
  });

  it("returns the raw path for session origin even with a relative path", () => {
    expect(workspaceFileCopyPath("/home/u/ws", "session", "sub/b.png")).toBe("sub/b.png");
  });
});

describe("readWorkspaceFileText", () => {
  it("returns text content when previewKind is text and encoding is utf8", () => {
    const file = {
      path: "a.txt",
      name: "a.txt",
      kind: "read" as const,
      missing: false,
      previewKind: "text" as const,
      contentEncoding: "utf8" as const,
      content: "hello",
    };
    expect(readWorkspaceFileText(file)).toBe("hello");
  });

  it("returns null for image preview", () => {
    const file = {
      path: "a.png",
      name: "a.png",
      kind: "read" as const,
      missing: false,
      previewKind: "image" as const,
      contentEncoding: "base64" as const,
      content: "AA==",
    };
    expect(readWorkspaceFileText(file)).toBeNull();
  });

  it("returns null when content encoding is not utf8", () => {
    const file = {
      path: "a.txt",
      name: "a.txt",
      kind: "read" as const,
      missing: false,
      previewKind: "text" as const,
      contentEncoding: "base64" as const,
      content: "AA==",
    };
    expect(readWorkspaceFileText(file)).toBeNull();
  });

  it("returns null when file is undefined", () => {
    expect(readWorkspaceFileText(undefined)).toBeNull();
  });

  it("returns null when content is not a string", () => {
    const file = {
      path: "a.txt",
      name: "a.txt",
      kind: "read" as const,
      missing: false,
      previewKind: "text" as const,
      contentEncoding: "utf8" as const,
      content: 42 as unknown as string,
    };
    expect(readWorkspaceFileText(file)).toBeNull();
  });
});
