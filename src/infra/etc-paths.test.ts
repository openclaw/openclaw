import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  const wrapped = {
    ...actual,
    constants: { ...actual.constants, X_OK: actual.constants.X_OK ?? 1 },
    readFileSync: (p: string, _encoding?: string) => {
      const content = state.files.get(p);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return content;
    },
    readdirSync: (p: string) => {
      const entries = state.dirEntries.get(p);
      if (entries === undefined) {
        const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return entries;
    },
    // Keep statSync/accessSync minimal — readEtcPaths doesn't use them.
    statSync: () => ({ isDirectory: () => false }),
    accessSync: () => {
      throw new Error("EACCES");
    },
  };

  return { ...wrapped, default: wrapped };
});

let readEtcPaths: typeof import("./path-env.js").readEtcPaths;

beforeAll(async () => {
  ({ readEtcPaths } = await import("./path-env.js"));
});

afterEach(() => {
  state.files.clear();
  state.dirEntries.clear();
});

describe("readEtcPaths", () => {
  it("returns empty array on non-darwin platforms", () => {
    expect(readEtcPaths("linux")).toEqual([]);
    expect(readEtcPaths("win32")).toEqual([]);
  });

  it("reads /etc/paths on darwin", () => {
    state.files.set("/etc/paths", "/usr/local/bin\n/usr/bin\n/bin\n/usr/sbin\n/sbin\n");
    state.dirEntries.set("/etc/paths.d", []);

    const result = readEtcPaths("darwin");
    expect(result).toEqual(["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("reads /etc/paths.d/* files", () => {
    state.files.set("/etc/paths", "/usr/bin\n/bin\n");
    state.dirEntries.set("/etc/paths.d", ["Homebrew", "TeX"]);
    state.files.set("/etc/paths.d/Homebrew", "/opt/homebrew/bin\n/opt/homebrew/sbin\n");
    state.files.set("/etc/paths.d/TeX", "/Library/TeX/texbin\n");

    const result = readEtcPaths("darwin");
    expect(result).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/Library/TeX/texbin",
    ]);
  });

  it("deduplicates entries across /etc/paths and /etc/paths.d", () => {
    state.files.set("/etc/paths", "/usr/local/bin\n/usr/bin\n");
    state.dirEntries.set("/etc/paths.d", ["Homebrew"]);
    state.files.set("/etc/paths.d/Homebrew", "/opt/homebrew/bin\n/usr/local/bin\n");

    const result = readEtcPaths("darwin");
    expect(result).toEqual(["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]);
  });

  it("skips blank lines and comment lines", () => {
    state.files.set("/etc/paths", "# system paths\n/usr/bin\n\n  \n/bin\n# trailing\n");
    state.dirEntries.set("/etc/paths.d", []);

    const result = readEtcPaths("darwin");
    expect(result).toEqual(["/usr/bin", "/bin"]);
  });

  it("handles missing /etc/paths gracefully", () => {
    // /etc/paths not in state.files → throws ENOENT
    state.dirEntries.set("/etc/paths.d", ["custom"]);
    state.files.set("/etc/paths.d/custom", "/opt/custom/bin\n");

    const result = readEtcPaths("darwin");
    expect(result).toEqual(["/opt/custom/bin"]);
  });

  it("handles missing /etc/paths.d gracefully", () => {
    state.files.set("/etc/paths", "/usr/bin\n");
    // /etc/paths.d not in state.dirEntries → throws ENOENT

    const result = readEtcPaths("darwin");
    expect(result).toEqual(["/usr/bin"]);
  });

  it("handles both /etc/paths and /etc/paths.d missing", () => {
    const result = readEtcPaths("darwin");
    expect(result).toEqual([]);
  });

  it("skips unreadable files in /etc/paths.d", () => {
    state.files.set("/etc/paths", "/usr/bin\n");
    state.dirEntries.set("/etc/paths.d", ["good", "bad"]);
    state.files.set("/etc/paths.d/good", "/opt/good/bin\n");
    // "bad" is listed in dirEntries but has no file content → throws ENOENT

    const result = readEtcPaths("darwin");
    expect(result).toEqual(["/usr/bin", "/opt/good/bin"]);
  });

  it("reads /etc/paths.d entries in sorted order", () => {
    state.files.set("/etc/paths", "");
    state.dirEntries.set("/etc/paths.d", ["zebra", "alpha"]);
    state.files.set("/etc/paths.d/zebra", "/opt/zebra/bin\n");
    state.files.set("/etc/paths.d/alpha", "/opt/alpha/bin\n");

    const result = readEtcPaths("darwin");
    // Sorted alphabetically: alpha before zebra
    expect(result).toEqual(["/opt/alpha/bin", "/opt/zebra/bin"]);
  });
});
