import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  noteStalePluginRuntimeSymlinks,
  type StalePluginRuntimeSymlinksFs,
} from "./doctor-plugin-runtime-symlinks.js";

interface FakeEntry {
  readonly name: string;
  readonly kind: "dir" | "symlink" | "file";
}

interface FakeSymlink {
  readonly target: string;
  readonly targetExists: boolean;
}

interface FakeTree {
  readonly entries: Record<string, readonly FakeEntry[]>;
  readonly symlinks: Record<string, FakeSymlink>;
}

function makeFs(tree: FakeTree): StalePluginRuntimeSymlinksFs {
  return {
    readdirSync(dir, _options) {
      const entries = tree.entries[dir];
      if (!entries) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${dir}`);
        err.code = "ENOENT";
        throw err;
      }
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.kind === "dir",
        isSymbolicLink: () => entry.kind === "symlink",
      }));
    },
    lstatSync(file) {
      const link = tree.symlinks[file];
      return {
        isSymbolicLink: () => link !== undefined,
      };
    },
    readlinkSync(file) {
      const link = tree.symlinks[file];
      if (!link) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: readlink ${file}`);
        err.code = "ENOENT";
        throw err;
      }
      return link.target;
    },
    statSync(file) {
      // Resolve through the symlink table when the path is a symlink target.
      const symlinkPointingHere = Object.values(tree.symlinks).find((s) => s.target === file);
      if (symlinkPointingHere && !symlinkPointingHere.targetExists) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: stat ${file}`);
        err.code = "ENOENT";
        throw err;
      }
      // For non-symlink paths or live targets, succeed.
      return {};
    },
  };
}

describe("noteStalePluginRuntimeSymlinks", () => {
  const packageRoot = "/usr/lib/node_modules/openclaw";
  const containingDir = path.dirname(packageRoot);

  it("does nothing when packageRoot is null", () => {
    const noteFn = vi.fn();
    noteStalePluginRuntimeSymlinks(null, { fs: makeFs({ entries: {}, symlinks: {} }), noteFn });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("does nothing when the parent directory is not node_modules", () => {
    const noteFn = vi.fn();
    noteStalePluginRuntimeSymlinks("/usr/lib/openclaw", {
      fs: makeFs({ entries: {}, symlinks: {} }),
      noteFn,
    });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("flags scoped @slack symlinks pointing at a missing plugin-runtime-deps target", () => {
    const noteFn = vi.fn();
    const slackScope = path.join(containingDir, "@slack");
    const webApiLink = path.join(slackScope, "web-api");
    const tree: FakeTree = {
      entries: {
        [containingDir]: [
          { name: "openclaw", kind: "dir" },
          { name: "@slack", kind: "dir" },
        ],
        [slackScope]: [{ name: "web-api", kind: "symlink" }],
      },
      symlinks: {
        [webApiLink]: {
          target:
            "/home/user/.openclaw/plugin-runtime-deps/openclaw-2026.4.26-aaa/node_modules/@slack/web-api",
          targetExists: false,
        },
      },
    };
    noteStalePluginRuntimeSymlinks(packageRoot, {
      fs: makeFs(tree),
      noteFn,
      shortenPath: (s) => s,
    });
    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Plugin-runtime symlinks");
    expect(message).toContain("@slack/web-api");
    expect(message).toContain("plugin-runtime-deps");
    expect(message).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("ignores plugin-runtime symlinks whose targets still exist", () => {
    const noteFn = vi.fn();
    const slackScope = path.join(containingDir, "@slack");
    const webApiLink = path.join(slackScope, "web-api");
    const tree: FakeTree = {
      entries: {
        [containingDir]: [{ name: "@slack", kind: "dir" }],
        [slackScope]: [{ name: "web-api", kind: "symlink" }],
      },
      symlinks: {
        [webApiLink]: {
          target:
            "/home/user/.openclaw/plugin-runtime-deps/openclaw-2026.4.29-aaa/node_modules/@slack/web-api",
          targetExists: true,
        },
      },
    };
    noteStalePluginRuntimeSymlinks(packageRoot, { fs: makeFs(tree), noteFn });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("ignores symlinks whose targets do not contain the plugin-runtime-deps marker", () => {
    const noteFn = vi.fn();
    const scope = path.join(containingDir, "@scope");
    const link = path.join(scope, "pkg");
    const tree: FakeTree = {
      entries: {
        [containingDir]: [{ name: "@scope", kind: "dir" }],
        [scope]: [{ name: "pkg", kind: "symlink" }],
      },
      symlinks: {
        [link]: {
          target: "/some/unrelated/path/node_modules/@scope/pkg",
          targetExists: false,
        },
      },
    };
    noteStalePluginRuntimeSymlinks(packageRoot, { fs: makeFs(tree), noteFn });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("collapses overflow with a count when many entries are stale", () => {
    const noteFn = vi.fn();
    const slackScope = path.join(containingDir, "@slack");
    const slackPkgs = ["bolt", "logger", "oauth", "socket-mode", "types", "web-api", "extra"];
    const symlinks: Record<string, FakeSymlink> = {};
    for (const pkg of slackPkgs) {
      symlinks[path.join(slackScope, pkg)] = {
        target: `/home/user/.openclaw/plugin-runtime-deps/openclaw-2026.4.26-aaa/node_modules/@slack/${pkg}`,
        targetExists: false,
      };
    }
    const tree: FakeTree = {
      entries: {
        [containingDir]: [{ name: "@slack", kind: "dir" }],
        [slackScope]: slackPkgs.map((name) => ({ name, kind: "symlink" as const })),
      },
      symlinks,
    };
    noteStalePluginRuntimeSymlinks(packageRoot, {
      fs: makeFs(tree),
      noteFn,
      shortenPath: (s) => s,
    });
    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message] = noteFn.mock.calls[0] ?? [];
    expect(message).toContain("…and 1 more");
  });

  it("ignores non-symlink entries even when named like a plugin-runtime package", () => {
    const noteFn = vi.fn();
    const slackScope = path.join(containingDir, "@slack");
    const tree: FakeTree = {
      entries: {
        [containingDir]: [{ name: "@slack", kind: "dir" }],
        [slackScope]: [{ name: "web-api", kind: "dir" }],
      },
      symlinks: {},
    };
    noteStalePluginRuntimeSymlinks(packageRoot, { fs: makeFs(tree), noteFn });
    expect(noteFn).not.toHaveBeenCalled();
  });
});
