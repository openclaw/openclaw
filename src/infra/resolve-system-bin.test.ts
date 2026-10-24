// Covers trusted system binary resolution across platform install roots.
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

if (process.platform !== "win32") {
  it.each([
    ["/usr/local/bin/openssl", "openssl", true],
    ["/opt/homebrew/bin/ffmpeg", "ffmpeg", true],
    ["/home/testuser/.local/bin/ffmpeg", "ffmpeg", false],
  ] as const)("does not trust %s by default", (executable, command, checkStrict) => {
    addExecutables(executable);
    expect(resolveSystemBin(command)).toBeNull();
    if (checkStrict) {
      expect(resolveSystemBin(command, { trust: "strict" })).toBeNull();
    }
  });

  it("prefers /usr/bin over /usr/local/bin (first match wins)", () => {
    addExecutables("/usr/bin/openssl", "/usr/local/bin/openssl");
    expect(resolveSystemBin("openssl")).toBe("/usr/bin/openssl");
  });

  it.each(["strict", "standard"] as const)(
    "%s extraDirs results do not poison callers without extraDirs",
    (trust) => {
      const extra = "/home/user/.local/bin";
      addExecutables(`${extra}/ffmpeg`);
      expect(resolveSystemBin("ffmpeg", { trust, extraDirs: [extra] })).toBe(`${extra}/ffmpeg`);
      expect(resolveSystemBin("ffmpeg", { trust })).toBeNull();
    },
  );
}

if (process.platform === "darwin" || process.platform === "linux") {
  const localDirs =
    process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin"];
  it.each(localDirs)("resolves a binary in %s with standard trust", (directory) => {
    const executable = `${directory}/ffmpeg`;
    addExecutables(executable);
    expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(executable);
  });

  it("prefers /usr/bin over package-manager paths with standard trust", () => {
    addExecutables("/usr/bin/ffmpeg", ...localDirs.map((dir) => `${dir}/ffmpeg`));
    expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/usr/bin/ffmpeg");
  });
}

it.runIf(process.platform === "darwin")(
  "standard trust results do not poison the strict cache",
  () => {
    addExecutables("/opt/homebrew/bin/ffmpeg");
    expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe("/opt/homebrew/bin/ffmpeg");
    expect(resolveSystemBin("ffmpeg")).toBeNull();
  },
);

it.each([
  ["linux", "strict", ""],
  ["linux", "standard", ""],
  ["win32", "strict", ""],
  ["win32", "standard", ".exe"],
] as const)(
  "bounds %s %s %s success entries with LRU eviction and retries failures",
  (platform, trust, extension) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const systemDir =
      platform === "win32" ? path.win32.join("C:\\Windows", "System32") : "/usr/bin";
    const commandFor = (label: string) => `${label}${extension}`;
    const candidateFor = (command: string) =>
      platform === "win32" && !extension
        ? path.win32.join(systemDir, `${command}.exe`)
        : path.join(systemDir, command);
    const addCommand = (command: string) => {
      const candidate = candidateFor(command);
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
  ] as const;
  addExecutables(...candidates.map(([, expected]) => path.resolve(expected)));

  for (const [command, expected, trust] of candidates) {
    expect(resolveSystemBin(command, { trust })).toBe(expected);
  }
  expect(resolveSystemBin("magick", { trust: "strict" })).toBeNull();

  addExecutables(path.resolve("/usr/bin/unix-only.exe"));
  expect(resolveSystemBin("unix-only", { trust: "standard" })).toBeNull();
});

it("resolves machine-wide Chocolatey shims only with standard trust on Windows", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const chocoFfmpeg = path.win32.join("C:\\", "ProgramData", "chocolatey", "bin", "ffmpeg.exe");
  executables.add(path.resolve(chocoFfmpeg));
  expect(resolveSystemBin("ffmpeg")).toBeNull();
  expect(resolveSystemBin("ffmpeg", { trust: "standard" })).toBe(chocoFfmpeg);
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

it("does not widen standard trust on unsupported Unix platforms", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("freebsd");
  addExecutables("/usr/local/bin/local-tool");
  expect(resolveSystemBin("local-tool", { trust: "strict" })).toBeNull();
  expect(resolveSystemBin("local-tool", { trust: "standard" })).toBeNull();
});
