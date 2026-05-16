import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _getTrustedDirs, _resetResolveSystemBin, resolveSystemBin } from "./resolve-system-bin.js";
import {
  _resetWindowsInstallRootsForTests,
  getWindowsInstallRoots,
  getWindowsProgramFilesRoots,
} from "./windows-install-roots.js";

let executables: Set<string>;

function addExecutables(...paths: string[]): void {
  for (const candidate of paths) {
    executables.add(candidate);
  }
}

function expectDirsContainAll(dirs: readonly string[], expected: readonly string[]): void {
  for (const dir of expected) {
    expect(dirs).toContain(dir);
  }
}

function expectDirsExcludeAll(dirs: readonly string[], excluded: readonly string[]): void {
  for (const dir of excluded) {
    expect(dirs).not.toContain(dir);
  }
}

beforeEach(() => {
  executables = new Set<string>();
  _resetResolveSystemBin((p: string) => executables.has(path.resolve(p)));
});

afterEach(() => {
  _resetResolveSystemBin();
  _resetWindowsInstallRootsForTests();
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
  it("never includes user-writable home directories", () => {
    const dirs = _getTrustedDirs();
    for (const dir of dirs) {
      expect(dir, `${dir} should not be user-writable`).not.toMatch(/\.(local|bun|yarn)/);
      expect(dir, `${dir} should not be a pnpm dir`).not.toContain("pnpm");
    }
  });

  if (process.platform !== "win32") {
    it("includes base Unix system directories only", () => {
      const dirs = _getTrustedDirs();
      expectDirsContainAll(dirs, ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
      expectDirsExcludeAll(dirs, ["/usr/local/bin"]);
    });

    it("ignores env-controlled NIX_PROFILES entries, including direct store paths", () => {
      const saved = process.env.NIX_PROFILES;
      try {
        process.env.NIX_PROFILES =
          "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffmpeg-7.1 /tmp/evil /home/user/.nix-profile /nix/var/nix/profiles/default";
        _resetResolveSystemBin((p: string) => executables.has(path.resolve(p)));
        const dirs = _getTrustedDirs();
        expectDirsExcludeAll(dirs, [
          "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffmpeg-7.1/bin",
          "/tmp/evil/bin",
          "/home/user/.nix-profile/bin",
          "/nix/var/nix/profiles/default/bin",
        ]);
      } finally {
        if (saved === undefined) {
          delete process.env.NIX_PROFILES;
        } else {
          process.env.NIX_PROFILES = saved;
        }
        _resetResolveSystemBin();
      }
    });
  }

  if (process.platform === "darwin") {
    it("does not include /opt/homebrew/bin in strict trust on macOS", () => {
      expectDirsExcludeAll(_getTrustedDirs("strict"), ["/opt/homebrew/bin", "/usr/local/bin"]);
    });

    it("includes /opt/homebrew/bin and /usr/local/bin in standard trust on macOS", () => {
      const dirs = _getTrustedDirs("standard");
      expectDirsContainAll(dirs, ["/opt/homebrew/bin", "/usr/local/bin"]);
    });

    it("places Homebrew dirs after system dirs in standard trust", () => {
      const dirs = [..._getTrustedDirs("standard")];
      const usrBinIdx = dirs.indexOf("/usr/bin");
      const brewIdx = dirs.indexOf("/opt/homebrew/bin");
      const localIdx = dirs.indexOf("/usr/local/bin");
      expect(usrBinIdx).toBeGreaterThanOrEqual(0);
      expect(brewIdx).toBeGreaterThan(usrBinIdx);
      expect(localIdx).toBeGreaterThan(usrBinIdx);
    });

    it("standard trust is a superset of strict trust on macOS", () => {
      const strict = _getTrustedDirs("strict");
      const standard = _getTrustedDirs("standard");
      for (const dir of strict) {
        expect(standard, `standard trust should include strict dir ${dir}`).toContain(dir);
      }
    });
  }

  if (process.platform === "linux") {
    it("includes Linux system-managed directories", () => {
      const dirs = _getTrustedDirs();
      expectDirsContainAll(dirs, ["/run/current-system/sw/bin", "/snap/bin"]);
    });

    it("includes /usr/local/bin in standard trust on Linux", () => {
      const dirs = _getTrustedDirs("standard");
      expect(dirs).toContain("/usr/local/bin");
    });

    it("places /usr/local/bin after /usr/bin in standard trust on Linux", () => {
      const dirs = [..._getTrustedDirs("standard")];
      const usrBinIdx = dirs.indexOf("/usr/bin");
      const usrLocalBinIdx = dirs.indexOf("/usr/local/bin");
      expect(usrBinIdx).toBeGreaterThanOrEqual(0);
      expect(usrLocalBinIdx).toBeGreaterThan(usrBinIdx);
    });
  }

  if (process.platform !== "darwin" && process.platform !== "linux") {
    it("standard trust equals strict trust on platforms without expansion", () => {
      const strict = _getTrustedDirs("strict");
      const standard = _getTrustedDirs("standard");
      expect(standard).toEqual(strict);
    });
  }

  if (process.platform === "win32") {
    it("includes Windows system directories", () => {
      const dirs = _getTrustedDirs();
      expect(dirs).toContain(path.win32.join(getWindowsInstallRoots().systemRoot, "System32"));
    });

    it("includes Program Files OpenSSL and ffmpeg paths", () => {
      const dirs = _getTrustedDirs();
      for (const programFilesRoot of getWindowsProgramFilesRoots()) {
        expect(dirs).toContain(path.win32.join(programFilesRoot, "OpenSSL-Win64", "bin"));
        expect(dirs).toContain(path.win32.join(programFilesRoot, "ffmpeg", "bin"));
      }
    });

    it("uses validated Windows install roots from HKLM values", () => {
      _resetWindowsInstallRootsForTests({
        queryRegistryValue: (key, valueName) => {
          if (
            key === "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" &&
            valueName === "SystemRoot"
          ) {
            return "D:\\Windows";
          }
          if (
            key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
            valueName === "ProgramFilesDir"
          ) {
            return "D:\\Program Files";
          }
          if (
            key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
            valueName === "ProgramW6432Dir"
          ) {
            return "D:\\Program Files";
          }
          if (
            key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
            valueName === "ProgramFilesDir (x86)"
          ) {
            return "E:\\Program Files (x86)";
          }
          return null;
        },
      });

      _resetResolveSystemBin((p: string) => executables.has(path.resolve(p)));
      const dirs = _getTrustedDirs();
      expect(dirs).toContain(path.win32.join("D:\\Windows", "System32"));
      expect(dirs).toContain(path.win32.join("D:\\Program Files", "OpenSSL-Win64", "bin"));
      expect(dirs).toContain(path.win32.join("E:\\Program Files (x86)", "OpenSSL", "bin"));
    });

    it("falls back safely when HKLM values are unavailable", () => {
      _resetWindowsInstallRootsForTests({
        queryRegistryValue: () => null,
      });

      _resetResolveSystemBin((p: string) => executables.has(path.resolve(p)));
      const dirs = _getTrustedDirs();
      const normalizedDirs = dirs.map((dir) => dir.toLowerCase());
      expectDirsContainAll(normalizedDirs, [
        path.win32.join("C:\\Windows", "System32").toLowerCase(),
        path.win32.join("C:\\Program Files", "OpenSSL-Win64", "bin").toLowerCase(),
        path.win32.join("C:\\Program Files (x86)", "OpenSSL", "bin").toLowerCase(),
      ]);
    });

    it("does not include Unix paths on Windows", () => {
      const dirs = _getTrustedDirs();
      expect(dirs).not.toContain("/usr/bin");
      expect(dirs).not.toContain("/bin");
    });
  }
});
