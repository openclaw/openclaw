import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
  execFileAsync: vi.fn(),
  note: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: mocks.access,
    realpath: mocks.realpath,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mocks.execFileAsync,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

import {
  collectCandidateDirs,
  findOpenClawInstallations,
  noteDuplicateInstallations,
} from "./doctor-duplicate-installs.js";

describe("collectCandidateDirs", () => {
  it("includes PATH entries", () => {
    const dirs = collectCandidateDirs({
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/home/test",
    });
    expect(dirs).toContain("/usr/bin");
    expect(dirs).toContain("/usr/local/bin");
  });

  it("includes well-known npm-global dir", () => {
    const dirs = collectCandidateDirs({
      PATH: "/usr/bin",
      HOME: "/home/test",
    });
    expect(dirs).toContain("/home/test/.npm-global/bin");
  });

  it("includes volta bin dir", () => {
    const dirs = collectCandidateDirs({
      PATH: "",
      HOME: "/home/test",
    });
    expect(dirs).toContain("/home/test/.volta/bin");
  });

  it("deduplicates directories", () => {
    const dirs = collectCandidateDirs({
      PATH: "/usr/bin:/usr/bin:/usr/bin",
      HOME: "/home/test",
    });
    const usrBinCount = dirs.filter((d) => d === "/usr/bin").length;
    expect(usrBinCount).toBe(1);
  });
});

describe("findOpenClawInstallations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no files exist
    mocks.access.mockRejectedValue(new Error("ENOENT"));
    mocks.realpath.mockImplementation(async (p: string) => p);
    mocks.execFileAsync.mockRejectedValue(new Error("not found"));
  });

  it("returns empty array when no binaries are found", async () => {
    const result = await findOpenClawInstallations({
      PATH: "/usr/bin",
      HOME: "/home/test",
    });
    expect(result).toEqual([]);
  });

  it("finds a single installation", async () => {
    mocks.access.mockImplementation(async (p: string) => {
      if (p === "/usr/bin/openclaw") {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    mocks.realpath.mockImplementation(async (p: string) => p);
    mocks.execFileAsync.mockImplementation(async (bin: string) => {
      if (bin === "/usr/bin/openclaw") {
        return { stdout: "2026.3.2\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await findOpenClawInstallations({
      PATH: "/usr/bin",
      HOME: "/home/test",
    });
    expect(result).toHaveLength(1);
    expect(result[0].binPath).toBe("/usr/bin/openclaw");
    expect(result[0].version).toBe("2026.3.2");
  });

  it("finds multiple installations at different real paths", async () => {
    const existing = new Set(["/usr/bin/openclaw", "/home/test/.npm-global/bin/openclaw"]);
    mocks.access.mockImplementation(async (p: string) => {
      if (existing.has(p)) {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    mocks.realpath.mockImplementation(async (p: string) => p);
    mocks.execFileAsync.mockImplementation(async (bin: string) => {
      if (bin === "/usr/bin/openclaw") {
        return { stdout: "2026.2.25\n", stderr: "" };
      }
      if (bin === "/home/test/.npm-global/bin/openclaw") {
        return { stdout: "2026.3.2\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await findOpenClawInstallations({
      PATH: "/usr/bin:/home/test/.npm-global/bin",
      HOME: "/home/test",
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.version)).toContain("2026.2.25");
    expect(result.map((i) => i.version)).toContain("2026.3.2");
  });

  it("deduplicates symlinks resolving to same real path", async () => {
    mocks.access.mockImplementation(async (p: string) => {
      if (p === "/usr/bin/openclaw" || p === "/usr/local/bin/openclaw") {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    // Both resolve to the same real path
    mocks.realpath.mockImplementation(async () => "/opt/openclaw/bin/openclaw");
    mocks.execFileAsync.mockResolvedValue({ stdout: "2026.3.2\n", stderr: "" });

    const result = await findOpenClawInstallations({
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/home/test",
    });
    expect(result).toHaveLength(1);
  });
});

describe("noteDuplicateInstallations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockRejectedValue(new Error("ENOENT"));
    mocks.realpath.mockImplementation(async (p: string) => p);
    mocks.execFileAsync.mockRejectedValue(new Error("not found"));
  });

  it("does not emit a note when 0 or 1 installations found", async () => {
    const result = await noteDuplicateInstallations();
    expect(result.warnings).toHaveLength(0);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("emits a note when multiple installations found", async () => {
    const existing = new Set(["/usr/bin/openclaw", "/home/test/.npm-global/bin/openclaw"]);
    mocks.access.mockImplementation(async (p: string) => {
      if (existing.has(p)) {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    mocks.realpath.mockImplementation(async (p: string) => p);
    mocks.execFileAsync.mockImplementation(async (bin: string) => {
      if (bin === "/usr/bin/openclaw") {
        return { stdout: "2026.2.25\n", stderr: "" };
      }
      if (bin === "/home/test/.npm-global/bin/openclaw") {
        return { stdout: "2026.3.2\n", stderr: "" };
      }
      throw new Error("not found");
    });

    // Ensure PATH includes both directories so they're scanned
    const origPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/home/test/.npm-global/bin";
    const origHome = process.env.HOME;
    process.env.HOME = "/home/test";

    try {
      const result = await noteDuplicateInstallations();
      expect(result.installations).toHaveLength(2);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Found 2 openclaw binaries"),
        "Duplicate installations",
      );
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
    }
  });
});
