// Covers trusted system binary resolution across platform install roots.
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ResolveSystemBin = typeof import("./resolve-system-bin.js").resolveSystemBin;

let resolveSystemBin: ResolveSystemBin;
let freshResolveSystemBinId = 0;

let executables: Set<string>;

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    {
      accessSync: (candidate: import("node:fs").PathLike) => {
        const candidatePath = String(candidate);
        if (!executables.has(path.resolve(candidatePath))) {
          throw Object.assign(new Error(`missing executable: ${candidatePath}`), {
            code: "ENOENT",
          });
        }
      },
    },
    { mirrorToDefault: true },
  );
});

function addExecutables(...paths: string[]): void {
  for (const candidate of paths) {
    executables.add(candidate);
  }
}

beforeEach(async () => {
  executables = new Set<string>();
  ({ resolveSystemBin } = await importFreshModule<typeof import("./resolve-system-bin.js")>(
    import.meta.url,
    `./resolve-system-bin.js?test=${freshResolveSystemBinId++}`,
  ));
});

describe("resolveSystemBin", () => {
  it("returns null when binary is not in any trusted directory", () => {
    expect(resolveSystemBin("nonexistent")).toBeNull();
  });

  if (process.platform !== "win32") {
    it("resolves a binary found in /usr/bin", () => {
      executables.add("/usr/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBe("/usr/bin/ffmpeg");
    });

    it.each([
      {
        name: "does NOT resolve a binary found in /usr/local/bin with strict trust",
        executable: "/usr/local/bin/openssl",
        command: "openssl",
        checkStrict: true,
      },
      {
        name: "does NOT resolve a binary found in /opt/homebrew/bin with strict trust",
        executable: "/opt/homebrew/bin/ffmpeg",
        command: "ffmpeg",
        checkStrict: true,
      },
      {
        name: "does NOT resolve a binary from a user-writable directory like ~/.local/bin",
        executable: "/home/testuser/.local/bin/ffmpeg",
        command: "ffmpeg",
        checkStrict: false,
      },
    ])("$name", ({ executable, command, checkStrict }) => {
      addExecutables(executable);
      expect(resolveSystemBin(command)).toBeNull();
      if (checkStrict) {
        expect(resolveSystemBin(command, { trust: "strict" })).toBeNull();
      }
    });

    it("prefers /usr/bin over /usr/local/bin (first match wins)", () => {
      executables.add("/usr/bin/openssl");
      executables.add("/usr/local/bin/openssl");
      expect(resolveSystemBin("openssl")).toBe("/usr/bin/openssl");
    });

    it("caches results across calls", () => {
      executables.add("/usr/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBe("/usr/bin/ffmpeg");

      executables.delete("/usr/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBe("/usr/bin/ffmpeg");
    });

    it("supports extraDirs for caller-specific paths", () => {
      const customDir = "/custom/system/bin";
      executables.add(`${customDir}/mytool`);
      expect(resolveSystemBin("mytool", { extraDirs: [customDir] })).toBe(`${customDir}/mytool`);
    });

    it("extraDirs results do not poison the cache for callers without extraDirs", () => {
      const untrustedDir = "/home/user/.local/bin";
      executables.add(`${untrustedDir}/ffmpeg`);

      expect(resolveSystemBin("ffmpeg", { extraDirs: [untrustedDir] })).toBe(
        `${untrustedDir}/ffmpeg`,
      );
      expect(resolveSystemBin("ffmpeg")).toBeNull();
    });
  }

  if (process.platform === "darwin") {
    it.each(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"])(
      "resolves a binary in %s with standard trust on macOS",
      (executable) => {
        addExecutables(executable);
        expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(executable);
      },
    );

    it("prefers /usr/bin over /opt/homebrew/bin with standard trust", () => {
      executables.add("/usr/bin/ffmpeg");
      executables.add("/opt/homebrew/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/bin/ffmpeg");
    });

    it("standard trust results do not poison the strict cache", () => {
      executables.add("/opt/homebrew/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/opt/homebrew/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg")).toBeNull();
    });

    it("extraDirs composes with standard trust", () => {
      const customDir = "/opt/custom/bin";
      executables.add(`${customDir}/mytool`);
      expect(resolveSystemBin("mytool", { trust: "standard", extraDirs: [customDir] })).toBe(
        `${customDir}/mytool`,
      );
    });
  }

  if (process.platform === "linux") {
    it("resolves a binary in /usr/local/bin with standard trust on Linux", () => {
      addExecutables("/usr/local/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/local/bin/ffmpeg");
    });

    it("prefers /usr/bin over /usr/local/bin with standard trust on Linux", () => {
      executables.add("/usr/bin/ffmpeg");
      executables.add("/usr/local/bin/ffmpeg");
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/bin/ffmpeg");
    });
  }
});

describe("trusted directory list", () => {
  it("resolves machine-wide Chocolatey shims only with standard trust on Windows", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const chocoFfmpeg = path.win32.join("C:\\", "ProgramData", "chocolatey", "bin", "ffmpeg.exe");
      executables.add(path.resolve(chocoFfmpeg));
      expect(resolveSystemBin("ffmpeg")).toBeNull();
      expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(chocoFfmpeg);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
