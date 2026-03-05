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

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

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

  it("ignores stale responses when a newer directory request finishes first", async () => {
    const oldDeferred = createDeferred<FsListResult>();
    const newDeferred = createDeferred<FsListResult>();

    const request = vi.fn((_: string, params?: unknown) => {
      const path = (params as { path: string }).path;
      if (path === "/old") {
        return oldDeferred.promise;
      }
      return newDeferred.promise;
    });

    const state = createState(request, { fsPath: "/home/user" });

    const oldLoad = loadFsDirectory(state, "/old");
    const newLoad = loadFsDirectory(state, "/new");

    expect(state.fsLoading).toBe(true);

    newDeferred.resolve({
      path: "/new",
      entries: [{ name: "fresh", type: "directory", path: "/new/fresh" }],
    });
    await newLoad;

    expect(state.fsPath).toBe("/new");
    expect(state.fsEntries).toEqual([{ name: "fresh", type: "directory", path: "/new/fresh" }]);
    expect(state.fsLoading).toBe(false);

    oldDeferred.resolve({
      path: "/old",
      entries: [{ name: "stale", type: "directory", path: "/old/stale" }],
    });
    await oldLoad;

    expect(state.fsPath).toBe("/new");
    expect(state.fsEntries).toEqual([{ name: "fresh", type: "directory", path: "/new/fresh" }]);
    expect(state.fsLoading).toBe(false);
  });

  it("ignores stale error when a newer directory request already succeeded", async () => {
    let rejectOld!: (err: unknown) => void;
    const oldPromise = new Promise<FsListResult>((_, reject) => {
      rejectOld = reject;
    });
    const newDeferred = createDeferred<FsListResult>();

    const request = vi.fn((_: string, params?: unknown) => {
      const path = (params as { path: string }).path;
      if (path === "/old") {
        return oldPromise;
      }
      return newDeferred.promise;
    });

    const state = createState(request, { fsPath: "/home/user" });

    const oldLoad = loadFsDirectory(state, "/old");
    const newLoad = loadFsDirectory(state, "/new");

    newDeferred.resolve({
      path: "/new",
      entries: [{ name: "fresh", type: "directory", path: "/new/fresh" }],
    });
    await newLoad;

    expect(state.fsPath).toBe("/new");
    expect(state.fsError).toBeNull();

    // Stale request rejects after newer one settled — should not overwrite good state
    rejectOld(new Error("stale error"));
    await oldLoad;

    expect(state.fsPath).toBe("/new");
    expect(state.fsError).toBeNull();
    expect(state.fsLoading).toBe(false);
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

  it("ignores stale read responses when a newer file request finishes first", async () => {
    const oldDeferred = createDeferred<FsReadResult>();
    const newDeferred = createDeferred<FsReadResult>();

    const request = vi.fn((_: string, params?: unknown) => {
      const path = (params as { path: string }).path;
      if (path === "/old.txt") {
        return oldDeferred.promise;
      }
      return newDeferred.promise;
    });

    const state = createState(request);

    const oldRead = readFsFile(state, "/old.txt");
    const newRead = readFsFile(state, "/new.txt");

    expect(state.fsFileLoading).toBe(true);

    newDeferred.resolve({
      path: "/new.txt",
      size: 3,
      truncated: false,
      content: "new",
    });
    await newRead;

    expect(state.fsFilePath).toBe("/new.txt");
    expect(state.fsFileContent).toBe("new");
    expect(state.fsFileLoading).toBe(false);

    oldDeferred.resolve({
      path: "/old.txt",
      size: 3,
      truncated: false,
      content: "old",
    });
    await oldRead;

    expect(state.fsFilePath).toBe("/new.txt");
    expect(state.fsFileContent).toBe("new");
    expect(state.fsFileLoading).toBe(false);
  });

  it("ignores stale error when a newer file request already succeeded", async () => {
    let rejectOld!: (err: unknown) => void;
    const oldPromise = new Promise<FsReadResult>((_, reject) => {
      rejectOld = reject;
    });
    const newDeferred = createDeferred<FsReadResult>();

    const request = vi.fn((_: string, params?: unknown) => {
      const path = (params as { path: string }).path;
      if (path === "/old.txt") {
        return oldPromise;
      }
      return newDeferred.promise;
    });

    const state = createState(request);

    const oldRead = readFsFile(state, "/old.txt");
    const newRead = readFsFile(state, "/new.txt");

    newDeferred.resolve({ path: "/new.txt", size: 3, truncated: false, content: "new" });
    await newRead;

    expect(state.fsFilePath).toBe("/new.txt");
    expect(state.fsFileContent).toBe("new");

    // Stale request rejects after newer one settled — should not overwrite
    rejectOld(new Error("stale read error"));
    await oldRead;

    expect(state.fsFilePath).toBe("/new.txt");
    expect(state.fsFileContent).toBe("new");
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

  it("navigates up within a UNC path", async () => {
    const result: FsListResult = { path: "\\\\server\\share\\docs", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "\\\\server\\share\\docs\\2026" });

    navigateFsUp(state);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "\\\\server\\share\\docs" });
    });
  });

  it("navigates to UNC share root from one level below", async () => {
    const result: FsListResult = { path: "\\\\server\\share", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "\\\\server\\share\\dir" });

    navigateFsUp(state);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "\\\\server\\share" });
    });
  });

  it("stays at UNC share root when already there", async () => {
    const result: FsListResult = { path: "\\\\server\\share", entries: [] };
    const request = vi.fn(async () => result);
    const state = createState(request, { fsPath: "\\\\server\\share" });

    navigateFsUp(state);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("fs.list", { path: "\\\\server\\share" });
    });
  });
});
