import { join, parse } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveToolPackageFile } from "./module-resolution.js";

// Mock fs module before importing the module under test
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockLstatSync = vi.fn();
const mockReaddirSync = vi.fn();

// Mock createRequire
const mockResolve = vi.fn();
const mockCreateRequire = vi.fn(() => ({
  resolve: mockResolve,
}));

vi.mock("node:module", () => ({
  createRequire: (...args: unknown[]) => mockCreateRequire(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => mockExistsSync(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => mockReadFileSync(...args),
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => mockRealpathSync(...args),
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => mockLstatSync(...args),
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => mockReaddirSync(...args),
  };
});

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  trace: vi.fn(),
};
vi.mock("../logging/logger.js", () => ({
  getLogger: () => mockLogger,
}));

describe("resolveToolPackageFile", () => {
  const normalizePath = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rootDir = parse(process.cwd()).root || "/";

  let originalPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalPath = process.env.PATH;
    mockLstatSync.mockReturnValue({ isFile: () => true }); // default to file
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("returns null when tool binary is not in PATH", () => {
    process.env.PATH = "/nonexistent";
    mockExistsSync.mockReturnValue(false);

    expect(resolveToolPackageFile("tool", "pkg", "file.js")).toBeNull();
  });

  it("resolves tool path and finds file via package resolution", () => {
    const fakeBinDir = join(rootDir, "fake", "bin");
    const fakeToolPath = join(fakeBinDir, "tool");
    const fakeResolvedToolPath = join(rootDir, "real", "path", "to", "tool");

    process.env.PATH = fakeBinDir;

    // 1. Resolve real path
    mockRealpathSync.mockReturnValue(fakeResolvedToolPath);

    // 2. Resolve package.json from tool location
    mockResolve.mockImplementation((id: string) => {
      if (id === "pkg/package.json") {
        return join(fakeResolvedToolPath, "pkg", "package.json");
      }
      throw new Error("Cannot find module");
    });

    // 3. Check for final file existence
    mockExistsSync.mockImplementation((p: string) => {
      if (normalizePath(p) === normalizePath(fakeToolPath)) {
        return true;
      }
      if (normalizePath(p) === normalizePath(join(fakeResolvedToolPath, "pkg", "file.js"))) {
        return true;
      }
      return false;
    });

    const result = resolveToolPackageFile("tool", "pkg", "file.js");
    expect(result).toBe(join(fakeResolvedToolPath, "pkg", "file.js"));
  });

  it("handles nested package resolution (parentPackage)", () => {
    const fakeBinDir = join(rootDir, "fake", "bin");
    const fakeToolPath = join(fakeBinDir, "tool");
    const fakeResolvedToolPath = join(rootDir, "real", "path", "to", "tool");

    process.env.PATH = fakeBinDir;

    mockExistsSync.mockImplementation((p: string) => {
      return normalizePath(p) === normalizePath(fakeToolPath);
    });
    mockRealpathSync.mockReturnValue(fakeResolvedToolPath);

    // Mock resolution failure for direct package, success via parent
    mockResolve.mockImplementation((id: string) => {
      if (id === "pkg/package.json") {
        throw new Error("Direct resolution failed");
      }
      if (id === "parent/package.json") {
        return join(fakeResolvedToolPath, "node_modules", "parent", "package.json");
      }
      throw new Error(`Unexpected resolve: ${id}`);
    });

    // Mock nested require for parent to find child
    const mockParentResolve = vi.fn((id: string) => {
      if (id === "pkg/package.json") {
        return join(
          fakeResolvedToolPath,
          "node_modules",
          "parent",
          "node_modules",
          "pkg",
          "package.json",
        );
      }
      throw new Error("Child resolution failed");
    });

    mockCreateRequire.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("parent")) {
        return { resolve: mockParentResolve } as unknown;
      }
      return { resolve: mockResolve } as unknown;
    });

    mockExistsSync.mockImplementation((p: string) => {
      if (normalizePath(p) === normalizePath(fakeToolPath)) {
        return true;
      }
      // Check for the final resolved file
      const finalPath = join(
        fakeResolvedToolPath,
        "node_modules",
        "parent",
        "node_modules",
        "pkg",
        "file.js",
      );
      if (normalizePath(p) === normalizePath(finalPath)) {
        return true;
      }
      return false;
    });

    const result = resolveToolPackageFile("tool", "pkg", "file.js", "parent");
    expect(result).toBe(
      join(fakeResolvedToolPath, "node_modules", "parent", "node_modules", "pkg", "file.js"),
    );
  });
});
