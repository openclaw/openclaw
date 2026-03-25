import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dirs: new Set<string>(),
  executables: new Set<string>(),
}));

const abs = (p: string) => path.resolve(p);
const setDir = (p: string) => state.dirs.add(abs(p));
const setExe = (p: string) => state.executables.add(abs(p));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);

  const wrapped = {
    ...actual,
    constants: { ...actual.constants, X_OK: actual.constants.X_OK ?? 1 },
    accessSync: (p: string, mode?: number) => {
      // `mode` is ignored in tests; we only model "is executable" or "not".
      if (!state.executables.has(absInMock(p))) {
        throw new Error(`EACCES: permission denied, access '${p}' (mode=${mode ?? 0})`);
      }
    },
    statSync: (p: string) => ({
      // Avoid throws for non-existent paths; the code under test only cares about isDirectory().
      isDirectory: () => state.dirs.has(absInMock(p)),
    }),
  };

  return { ...wrapped, default: wrapped };
});

vi.mock("./env.js", () => ({
  isTruthyEnvValue: (value?: string) => value === "1" || value === "true",
}));

let ensureOpenClawCliOnPath: typeof import("./path-env.js").ensureOpenClawCliOnPath;

describe("ensureOpenClawCliOnPath", () => {
  const envKeys = [
    "PATH",
    "OPENCLAW_PATH_BOOTSTRAPPED",
    "OPENCLAW_ALLOW_PROJECT_LOCAL_BIN",
    "MISE_DATA_DIR",
    "HOMEBREW_PREFIX",
    "HOMEBREW_BREW_FILE",
    "XDG_BIN_HOME",
  ] as const;
  let envSnapshot: Record<(typeof envKeys)[number], string | undefined>;

  beforeAll(async () => {
    ({ ensureOpenClawCliOnPath } = await import("./path-env.js"));
  });

  beforeEach(() => {
    envSnapshot = Object.fromEntries(envKeys.map((k) => [k, process.env[k]])) as typeof envSnapshot;
    state.dirs.clear();
    state.executables.clear();

    setDir("/usr/bin");
    setDir("/bin");
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of envKeys) {
      const value = envSnapshot[k];
      if (value === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = value;
      }
    }
  });

  function setupAppCliRoot(name: string) {
    const tmp = abs(`/tmp/openclaw-path/${name}`);
    const appBinDir = path.join(tmp, "AppBin");
    const appCli = path.join(appBinDir, "openclaw");
    setDir(tmp);
    setDir(appBinDir);
    setExe(appCli);
    return { tmp, appBinDir, appCli };
  }

  function bootstrapPath(params: {
    execPath: string;
    cwd: string;
    homeDir: string;
    platform: NodeJS.Platform;
    allowProjectLocalBin?: boolean;
  }) {
    ensureOpenClawCliOnPath(params);
    return (process.env.PATH ?? "").split(path.delimiter);
  }

  it("prepends the bundled app bin dir when a sibling openclaw exists", () => {
    const { tmp, appBinDir, appCli } = setupAppCliRoot("case-bundled");
    process.env.PATH = "/usr/bin";
    delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    expect(updated[0]).toBe(appBinDir);
  });

  it("is idempotent", () => {
    process.env.PATH = "/bin";
    process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";
    ensureOpenClawCliOnPath({
      execPath: "/tmp/does-not-matter",
      cwd: "/tmp",
      homeDir: "/tmp",
      platform: "darwin",
    });
    expect(process.env.PATH).toBe("/bin");
  });

  it("prepends mise shims when available", () => {
    const { tmp, appBinDir, appCli } = setupAppCliRoot("case-mise");
    const miseDataDir = path.join(tmp, "mise");
    const shimsDir = path.join(miseDataDir, "shims");
    setDir(miseDataDir);
    setDir(shimsDir);

    process.env.MISE_DATA_DIR = miseDataDir;
    process.env.PATH = "/usr/bin";
    delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "darwin",
    });
    const appBinIndex = updated.indexOf(appBinDir);
    const shimsIndex = updated.indexOf(shimsDir);
    expect(appBinIndex).toBeGreaterThanOrEqual(0);
    expect(shimsIndex).toBeGreaterThan(appBinIndex);
  });

  it.each([
    {
      name: "explicit option",
      envValue: undefined,
      allowProjectLocalBin: true,
    },
    {
      name: "truthy env",
      envValue: "1",
      allowProjectLocalBin: undefined,
    },
  ])(
    "only appends project-local node_modules/.bin when enabled via $name",
    ({ envValue, allowProjectLocalBin }) => {
      const { tmp, appCli } = setupAppCliRoot("case-project-local");
      const localBinDir = path.join(tmp, "node_modules", ".bin");
      const localCli = path.join(localBinDir, "openclaw");
      setDir(path.join(tmp, "node_modules"));
      setDir(localBinDir);
      setExe(localCli);

      process.env.PATH = "/usr/bin";
      delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      delete process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN;

      const withoutOptIn = bootstrapPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });
      expect(withoutOptIn.includes(localBinDir)).toBe(false);

      process.env.PATH = "/usr/bin";
      delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      if (envValue === undefined) {
        delete process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN;
      } else {
        process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN = envValue;
      }

      const withOptIn = bootstrapPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
        ...(allowProjectLocalBin === undefined ? {} : { allowProjectLocalBin }),
      });
      const usrBinIndex = withOptIn.indexOf("/usr/bin");
      const localIndex = withOptIn.indexOf(localBinDir);
      expect(usrBinIndex).toBeGreaterThanOrEqual(0);
      expect(localIndex).toBeGreaterThan(usrBinIndex);
    },
  );

  it("prepends XDG_BIN_HOME ahead of other user bin fallbacks", () => {
    const { tmp, appCli } = setupAppCliRoot("case-xdg-bin-home");
    const xdgBinHome = path.join(tmp, "xdg-bin");
    const localBin = path.join(tmp, ".local", "bin");
    setDir(xdgBinHome);
    setDir(path.join(tmp, ".local"));
    setDir(localBin);

    process.env.PATH = "/usr/bin";
    process.env.XDG_BIN_HOME = xdgBinHome;
    delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;

    const updated = bootstrapPath({
      execPath: appCli,
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expect(updated.indexOf(xdgBinHome)).toBeLessThan(updated.indexOf(localBin));
  });

  it("prepends Linuxbrew dirs when present", () => {
    const tmp = abs("/tmp/openclaw-path/case-linuxbrew");
    const execDir = path.join(tmp, "exec");
    setDir(tmp);
    setDir(execDir);

    const linuxbrewDir = path.join(tmp, ".linuxbrew");
    const linuxbrewBin = path.join(linuxbrewDir, "bin");
    const linuxbrewSbin = path.join(linuxbrewDir, "sbin");
    setDir(linuxbrewDir);
    setDir(linuxbrewBin);
    setDir(linuxbrewSbin);

    process.env.PATH = "/usr/bin";
    delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    delete process.env.HOMEBREW_PREFIX;
    delete process.env.HOMEBREW_BREW_FILE;
    delete process.env.XDG_BIN_HOME;

    const parts = bootstrapPath({
      execPath: path.join(execDir, "node"),
      cwd: tmp,
      homeDir: tmp,
      platform: "linux",
    });
    expect(parts[0]).toBe(linuxbrewBin);
    expect(parts[1]).toBe(linuxbrewSbin);
  });
});
