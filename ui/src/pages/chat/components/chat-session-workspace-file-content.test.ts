import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";
import {
  workspaceBrowserFilePath,
  workspaceFileCopyPath,
} from "./chat-session-workspace-file-content.ts";
import { RailRow } from "./chat-session-workspace-row.tsx";

// ── Pure helper tests ────────────────────────────────────────────────────────

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
    expect(workspaceBrowserFilePath("/ws", "\\\\server\\share\\f.txt")).toBe(
      "\\\\server\\share\\f.txt",
    );
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

  it("returns the raw path for session origin even with a relative path", () => {
    expect(workspaceFileCopyPath("/home/u/ws", "session", "sub/b.png")).toBe(
      "sub/b.png",
    );
  });
});

// ── Row-level copy-button wiring ─────────────────────────────────────────────

function makeWorkspace(
  overrides: Partial<SessionWorkspaceProps> = {},
): SessionWorkspaceProps {
  return {
    list: { root: "/home/user/workspace" },
    activeId: "",
    sessionKey: "test-session",
    onOpenFile: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
  } as unknown as SessionWorkspaceProps;
}

describe("RailRow copy-button wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the absolute workspace path for a workspace-origin file", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        createComponent(RailRow, {
        file: {
          key: "ws-1",
          path: "notes/a.txt",
          name: "a.txt",
          origin: "workspace",
        },
        workspace: makeWorkspace(),
        view: "list",
      }),
      { container },
    );
    flush();

    const copyBtn = container.querySelector<HTMLButtonElement>("button.chat-copy-btn");
    expect(copyBtn).not.toBeNull();
    copyBtn?.click();

    await waitForSolid(() =>
      expect(writeText).toHaveBeenCalledWith("/home/user/workspace/notes/a.txt"),
    );

    container.remove();
  });

  it("copies the raw relative path for a session-origin file", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        createComponent(RailRow, {
        file: {
          key: "sess-1",
          path: "sub/b.png",
          name: "b.png",
          origin: "session",
        },
        workspace: makeWorkspace(),
        view: "list",
      }),
      { container },
    );
    flush();

    const copyBtn = container.querySelector<HTMLButtonElement>("button.chat-copy-btn");
    expect(copyBtn).not.toBeNull();
    copyBtn?.click();

    await waitForSolid(() =>
      expect(writeText).toHaveBeenCalledWith("sub/b.png"),
    );

    container.remove();
  });
});
