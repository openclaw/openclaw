import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type ResolveSystemBin = typeof import("./resolve-system-bin.js").resolveSystemBin;

const windowsRoots = vi.hoisted(() => ({
  systemRoot: "C:\\Windows",
  programFilesRoots: ["C:\\Program Files", "C:\\Program Files (x86)"],
}));

vi.mock("./windows-install-roots.js", async () => {
  const actual = await vi.importActual<typeof import("./windows-install-roots.js")>(
    "./windows-install-roots.js",
  );
  return {
    ...actual,
    getWindowsInstallRoots: () => ({
      systemRoot: windowsRoots.systemRoot,
      programFiles: windowsRoots.programFilesRoots[0] ?? "C:\\Program Files",
      programFilesX86: windowsRoots.programFilesRoots[1] ?? "C:\\Program Files (x86)",
      programW6432: windowsRoots.programFilesRoots[0] ?? null,
    }),
    getWindowsProgramFilesRoots: () => windowsRoots.programFilesRoots,
  };
});

let resolveSystemBin: ResolveSystemBin;
let freshResolveSystemBinId = 0;

let executables: Set<string>;
const addExecutables = (...paths: string[]) => paths.forEach((entry) => executables.add(entry));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  executables = new Set<string>();
  vi.spyOn(fs, "accessSync").mockImplementation((candidate) => {
    const candidatePath = String(candidate);
    if (!executables.has(path.resolve(candidatePath))) {
      throw Object.assign(new Error(`missing executable: ${candidatePath}`), {
        code: "ENOENT",
      });
    }
  });
  windowsRoots.systemRoot = "C:\\Windows";
  windowsRoots.programFilesRoots = ["C:\\Program Files", "C:\\Program Files (x86)"];
  ({ resolveSystemBin } = await importFreshModule<typeof import("./resolve-system-bin.js")>(
    import.meta.url,
    `./resolve-system-bin.js?test=${freshResolveSystemBinId++}`,
  ));
});

it.each([
  ["linux", "/usr/local/bin", true],
  ["darwin", "/opt/homebrew/bin", true],
  ["darwin", "/usr/local/bin", true],
  ["freebsd", "/usr/local/bin", false],
] as const)("keeps %s trust and cache boundaries for %s", (platform, directory, standard) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  addExecutables(`${directory}/ffmpeg`, `${directory}/openssl`, "/usr/bin/openssl");
  expect(resolveSystemBin("ffmpeg")).toBeNull();
  expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(
    standard ? `${directory}/ffmpeg` : null,
  );
  expect(resolveSystemBin("ffmpeg", { trust: "strict" })).toBeNull();
  for (const trust of ["strict", "standard"] as const) {
    expect(resolveSystemBin("openssl", { trust })).toBe("/usr/bin/openssl");
  }
});

it.each(["strict", "standard"] as const)(
  "%s only accepts user directories with an explicit per-call opt-in",
  (trust) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const extra = "/home/user/.local/bin";
    addExecutables(`${extra}/ffmpeg`);
    expect(resolveSystemBin("ffmpeg", { trust })).toBeNull();
    expect(resolveSystemBin("ffmpeg", { trust, extraDirs: [extra] })).toBe(`${extra}/ffmpeg`);
    expect(resolveSystemBin("ffmpeg", { trust })).toBeNull();
  },
);

it.each([
  ["linux", "strict", ""],
  ["win32", "standard", ".exe"],
] as const)(
  "bounds %s %s %s success entries with LRU eviction and retries failures",
  (platform, trust, extension) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const systemDir =
      platform === "win32" ? path.win32.join("C:\\Windows", "System32") : "/usr/bin";
    const commandFor = (label: string) => `${label}${extension}`;
    const addCommand = (command: string) => {
      const candidate = path.join(systemDir, command);
      addExecutables(path.resolve(candidate));
      return candidate;
    };
    const cold = commandFor("cold");
    const hot = commandFor("hot");

    expect(resolveSystemBin(cold, { trust })).toBeNull();
    const coldCandidate = addCommand(cold);
    const hotCandidate = addCommand(hot);
    expect(resolveSystemBin(cold, { trust })).toBe(coldCandidate);
    expect(resolveSystemBin(hot, { trust })).toBe(hotCandidate);
    for (let index = 0; index < 510; index += 1) {
      const filler = commandFor(`filler-${index}`);
      const fillerCandidate = addCommand(filler);
      expect(resolveSystemBin(filler, { trust })).toBe(fillerCandidate);
    }

    expect(resolveSystemBin(hot, { trust })).toBe(hotCandidate);
    const newest = commandFor("newest");
    const newestCandidate = addCommand(newest);
    expect(resolveSystemBin(newest, { trust })).toBe(newestCandidate);
    executables.delete(path.resolve(coldCandidate));
    executables.delete(path.resolve(hotCandidate));

    expect(resolveSystemBin(hot, { trust })).toBe(hotCandidate);
    expect(resolveSystemBin(cold, { trust })).toBeNull();
  },
);
it("resolves Windows system and Program Files tools through the public resolver", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  windowsRoots.systemRoot = "D:\\Windows";
  windowsRoots.programFilesRoots = ["D:\\Program Files", "E:\\Program Files (x86)"];
  const candidates = [
    ["pwsh", "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe", "strict"],
    ["openssl", "D:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe", "strict"],
    ["ffmpeg", "E:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe", "strict"],
    ["magick", "D:\\Program Files\\ImageMagick\\magick.exe", "standard"],
    ["gm", "E:\\Program Files (x86)\\GraphicsMagick\\gm.exe", "standard"],
    ["choco", "D:\\ProgramData\\chocolatey\\bin\\choco.exe", "standard"],
  ] as const;
  addExecutables(...candidates.map(([, expected]) => path.resolve(expected)));

  for (const [command, expected, trust] of candidates) {
    expect(resolveSystemBin(command, { trust })).toBe(expected);
    if (trust === "standard") {
      expect(resolveSystemBin(command, { trust: "strict" })).toBeNull();
    }
  }

  addExecutables(path.resolve("/usr/bin/unix-only.exe"));
  expect(resolveSystemBin("unix-only", { trust: "standard" })).toBeNull();
});

it("uses fixed Linux system paths and ignores NIX_PROFILES", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.stubEnv(
    "NIX_PROFILES",
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffmpeg-7.1 /tmp/evil /home/user/.nix-profile",
  );
  addExecutables(
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffmpeg-7.1/bin/ffmpeg",
    "/run/current-system/sw/bin/nix-tool",
    "/snap/bin/snap-tool",
    "/usr/local/bin/local-tool",
  );

  expect(resolveSystemBin("ffmpeg")).toBeNull();
  expect(resolveSystemBin("nix-tool")).toBe("/run/current-system/sw/bin/nix-tool");
  expect(resolveSystemBin("snap-tool")).toBe("/snap/bin/snap-tool");
  expect(resolveSystemBin("local-tool")).toBeNull();
  expect(resolveSystemBin("local-tool", { trust: "standard" })).toBe("/usr/local/bin/local-tool");
});
