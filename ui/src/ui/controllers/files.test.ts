import { describe, expect, it, vi } from "vitest";
import {
  loadFsDirectory,
  navigateFsUp,
  readFsFile,
  type FilesState,
  type FsListResult,
  type FsReadResult,
} from "./files.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<FilesState> = {}): FilesState {
  return {
    client: { request } as unknown as FilesState["client"],
    connected: true,
    fsPath: "/home/user",
    fsLoading: false,
    fsEntries: [],
    fsError: null,
    fsFileContent: null,
    fsFilePath: null,
    fsFileLoading: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadFsDirectory
// ---------------------------------------------------------------------------

describe("loadFsDirectory", () => {
  it("loads entries from the gateway and updates state", async () => {
    const result: FsListResult = {
      path: "/home/user",
      entries: [
        { name: "docs", type: "directory", path: "/home/user/docs" },
        { name: "file.txt", type: "file", path: "/home/user/file.txt" },
      ],
    };
    const request = vi.fn(async () => result);
    const state = createState(request);

    await loadFsDirectory(state);

    expect(request).toHaveBeenCalledWith("fs.list", { path: "/home/user" });
    expect(state.fsPath).toBe("/home/user");
    expect(state.fsEntries).toEqual(result.entries);
    expect(state.fsLoading).toBe(false);
    expect(state.fsError).toBeNull();
  });

  it("loads a specific directory path when provided", async () => {
    const result: FsListResult = {
      path: "/tmp",
      entries: [],
    };
    const request = vi.fn(async () => result);
    const state = createState(request);

    await loadFsDirectory(state, "/tmp");

    expect(request).toHaveBeenCalledWith("fs.list", { path: "/tmp" });
    expect(state.fsPath).toBe("/tmp");
    expect(state.fsEntries).toEqual([]);
  });

  it("captures errors and sets fsError", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway timeout");
    });
    const state = createState(request);

    await loadFsDirectory(state);

    expect(state.fsError).toContain("gateway timeout");
    expect(state.fsLoading).toBe(false);
    expect(state.fsEntries).toEqual([]);
  });

  it("clears file content when loading a directory", async () => {
    const request = vi.fn(async () => ({ path: "/home", entries: [] }));
    const state = createState(request, {
      fsFileContent: "old content",
      fsFilePath: "/old/file.txt",
    });

    await loadFsDirectory(state);

    expect(state.fsFileContent).toBeNull();
    expect(state.fsFilePath).toBeNull();
  });

  it("does nothing when client is null", async () => {
    const request = vi.fn();
    const state = createState(request, { client: null });

    await loadFsDirectory(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.fsLoading).toBe(false);
  });

  it("does nothing when not connected", async () => {
    const request = vi.fn();
    const state = createState(request, { connected: false });

    await loadFsDirectory(state);

    expect(request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readFsFile
// ---------------------------------------------------------------------------

describe("readFsFile", () => {
  it("reads file content and updates state", async () => {
    const result: FsReadResult = {
      path: "/home/user/readme.md",
      size: 42,
      truncated: false,
      content: "# Hello",
    };
    const request = vi.fn(async () => result);
    const state = createState(request);

    await readFsFile(state, "/home/user/readme.md");

    expect(request).toHaveBeenCalledWith("fs.read", { path: "/home/user/readme.md" });
    expect(state.fsFilePath).toBe("/home/user/readme.md");
    expect(state.fsFileContent).toBe("# Hello");
    expect(state.fsFileLoading).toBe(false);
  });

  it("sets error content when read fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const state = createState(request);

    await readFsFile(state, "/etc/shadow");

    expect(state.fsFilePath).toBe("/etc/shadow");
    expect(state.fsFileContent).toContain("Error:");
    expect(state.fsFileContent).toContain("permission denied");
    expect(state.fsFileLoading).toBe(false);
  });

  it("does nothing when client is null", async () => {
    const request = vi.fn();
    const state = createState(request, { client: null });

    await readFsFile(state, "/some/file");

    expect(request).not.toHaveBeenCalled();
  });

  it("does nothing when not connected", async () => {
    const request = vi.fn();
    const state = createState(request, { connected: false });

    await readFsFile(state, "/some/file");

    expect(request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// navigateFsUp
// ---------------------------------------------------------------------------

describe("navigateFsUp", () => {
  it("navigates to the parent directory", async () => {
    const result: FsListResult = { path: "/home", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "/home/user" });

    navigateFsUp(state);

    // navigateFsUp fires loadFsDirectory asynchronously (void return)
    // Wait for the request to be issued
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "/home" });
    });
  });

  it("navigates to root when one level deep", async () => {
    const result: FsListResult = { path: "/", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "/home" });

    navigateFsUp(state);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "/" });
    });
  });

  it("does nothing when already at root", () => {
    const request = vi.fn();
    const state = createState(request, { fsPath: "/" });

    navigateFsUp(state);

    expect(request).not.toHaveBeenCalled();
  });

  it("handles Windows-style paths correctly", async () => {
    const result: FsListResult = { path: "C:\\Users\\alice", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "C:\\Users\\alice\\proj" });

    navigateFsUp(state);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "C:\\Users\\alice" });
    });
  });

  it("navigates to Windows drive root when one level deep", async () => {
    const result: FsListResult = { path: "C:\\", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "C:\\Users" });

    navigateFsUp(state);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "C:\\" });
    });
  });
});
