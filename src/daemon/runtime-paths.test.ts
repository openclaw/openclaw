import { afterEach, describe, expect, it, vi } from "vitest";

// Platform fixtures do not create host files; the generated bootstrap has separate process proof.
vi.mock("../../runtime-process-scripts.generated.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime-process-scripts.generated.mjs")>()),
  createRuntimeProcessScriptFile: () => ({
    url: new URL("file:///qa/daemon-runtime-probe.mjs"),
    dispose() {},
  }),
}));

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mocked = { ...actual, ...fsMocks };
  return { ...mocked, default: mocked };
});

import * as processExec from "../process/exec.js";
import { resolveNodeProgramArguments } from "./program-args.js";
import {
  renderSystemNodeWarning,
  resolveBunRuntimeInfo,
  resolvePreferredBunPath,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function mockNodeRealpath(realpaths: Record<string, string> = {}) {
  fsMocks.realpath.mockImplementation(async (target: string) => realpaths[target] ?? target);
}

function mockNodePathPresent(...nodePaths: string[]) {
  mockNodeRealpath();
  fsMocks.access.mockImplementation(async (target: string) => {
    if (nodePaths.includes(target)) {
      return;
    }
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
}

function nodeRuntime(
  nodeVersion: string,
  sqliteVersion: string | null = "3.51.3",
  nodeSharedSqlite = false,
  text = !["22.", "24.14.", "24.15.", "25.", "26.0."].some((prefix) =>
    nodeVersion.startsWith(prefix),
  ),
) {
  return {
    stdout: `${JSON.stringify({ nodeVersion, sqliteVersion, nodeSharedSqlite, sqliteProbe: { available: sqliteVersion !== null, version: sqliteVersion, text, blob: true, json: true } })}\n`,
    stderr: "",
  };
}

function bunRuntime(
  bunVersion: string | null,
  hasNodeSqlite = true,
  sqliteVersion: string | null = hasNodeSqlite ? "3.51.3" : null,
  sqliteSelectionError: string | null = null,
  sqliteLibraryPath: string | null = null,
) {
  const available = hasNodeSqlite && !sqliteSelectionError;
  return {
    stdout: `${JSON.stringify({ bunVersion, hasNodeSqlite, sqliteVersion, sqliteSelectionError, sqliteLibraryPath, sqliteProbe: { available, version: sqliteVersion, text: available, blob: available, json: available } })}\n`,
    stderr: "",
  };
}

function preferredNode(options: Parameters<typeof resolvePreferredNodePath>[0]) {
  return resolvePreferredNodePath({ env: {}, runtime: "node", platform: "darwin", ...options });
}

const INVALID_SQLITE_OVERRIDE =
  "Cannot use SQLite library /opt/broken/libsqlite3.dylib: missing file. Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.";

it("keeps missing Bun metadata distinct from unsupported", async () => {
  vi.spyOn(processExec, "runExec").mockResolvedValue({ stdout: "{}", stderr: "" });
  const result = await resolveBunRuntimeInfo("/usr/bin/bun");
  expect(result).toMatchObject({ status: "probe-failed", error: expect.any(Error) });
  expect(result).not.toHaveProperty("version");
});

describe.each(["node", "bun"] as const)("%s probe failures", (runtime) => {
  it("retains failed-probe evidence when another candidate is unsupported", async () => {
    mockNodePathPresent(
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/usr/local/bin/bun",
      "/usr/bin/bun",
    );
    vi.spyOn(processExec, "runExec")
      .mockResolvedValueOnce(
        runtime === "node" ? nodeRuntime("20.0.0", null) : bunRuntime("1.3.0", false),
      )
      .mockRejectedValue(new Error("EACCES"));
    const resolve = runtime === "node" ? resolvePreferredNodePath : resolvePreferredBunPath;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "execPath", "get").mockReturnValue("/fixture/other");
    await expect(resolve({ env: {}, runtime })).rejects.toThrow(/check failed.*EACCES/s);
  });
});

it("rejects a Bun node shim even when its emulated Node and SQLite versions are supported", async () => {
  mockNodePathPresent("/usr/bin/node");
  const metadata = JSON.parse(nodeRuntime("26.12.1").stdout);
  vi.spyOn(processExec, "runExec").mockResolvedValue({
    stdout: JSON.stringify({ ...metadata, bunVersion: "1.4.4" }),
    stderr: "",
  });
  const result = await resolveSystemNodeInfo({ env: {}, platform: "linux" });
  expect(result).toMatchObject({
    status: "unsupported",
    capabilityError: "The executable is Bun, not Node.",
  });
});

describe("resolvePreferredNodePath", () => {
  it.each([
    ["24.22.1", false, "unsupported"],
    ["24.15.0+vendor.1", true, "unsupported"],
  ] as const)(
    "uses the selected runtime's reported SQLite TEXT capability on Node %s",
    async (version, lossless, expected) => {
      mockNodePathPresent("/usr/bin/node");
      vi.spyOn(processExec, "runExec").mockResolvedValue(
        nodeRuntime(version, "3.51.3", false, lossless),
      );
      const result = await resolveSystemNodeInfo({ env: {}, platform: "linux" });
      expect(result).toMatchObject({
        status: expected,
        version,
        sqliteProbe: { text: lossless, blob: true, json: true },
      });
    },
  );

  const darwinNode = "/opt/homebrew/bin/node";
  const fnmNode = "/Users/test/.fnm/node-versions/v24.22.1/installation/bin/node";
  const linuxSystemNode = "/usr/bin/node";
  const nvmNode = "/home/test/.nvm/versions/node/v24.22.1/bin/node";

  it("reports an exec failure instead of advising a Node upgrade during install", async () => {
    mockNodePathPresent(linuxSystemNode);
    vi.spyOn(processExec, "runExec").mockRejectedValue(new Error("spawn EACCES"));
    const install = async () => {
      const runtimePath = await preferredNode({
        platform: "linux",
        execPath: linuxSystemNode,
      });
      return resolveNodeProgramArguments({
        host: "gateway.example",
        port: 18789,
        runtime: "node",
        runtimePath,
      });
    };
    await expect(install()).rejects.toThrow(
      /Node runtime check failed.*\/usr\/bin\/node.*cwd.*EACCES/s,
    );
  });

  it("selects a supported current versioned Node executable on Windows", async () => {
    const execPath = "D:\\Tools\\node24.exe";
    mockNodePathPresent();
    const execFile = vi.spyOn(processExec, "runExec").mockResolvedValue(nodeRuntime("24.22.1"));

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "win32",
      execPath,
    });

    expect(result).toBe(execPath);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  const upperNvm = "/home/test/.NVM/versions/node/v24/bin/node";
  it.each([
    ["darwin", darwinNode, fnmNode, true, "3.51.3", fnmNode, 1],
    ["linux", linuxSystemNode, nvmNode, false, "3.51.2", nvmNode, 2],
    ["linux", linuxSystemNode, upperNvm, false, "3.51.3", linuxSystemNode, 2],
  ] as const)(
    "selects Node on %s from %s for %s (prefer current=%s, SQLite=%s)",
    async (platform, system, current, prefer, systemSqlite, selected, probes) => {
      mockNodePathPresent(system);
      const execFile = vi
        .spyOn(processExec, "runExec")
        .mockResolvedValueOnce(nodeRuntime(prefer ? "26.12.1" : "24.22.1"))
        .mockResolvedValueOnce(nodeRuntime("24.22.1", systemSqlite));
      expect(
        await preferredNode({ platform, execPath: current, preferCurrentExecPath: prefer }),
      ).toBe(selected);
      expect(execFile).toHaveBeenCalledTimes(probes);
    },
  );

  it("finds a later system Node accepted by the target engine", async () => {
    const targetCompatibleNode = "/opt/homebrew/opt/node/bin/node";
    mockNodePathPresent(darwinNode, targetCompatibleNode);
    vi.spyOn(processExec, "runExec")
      .mockResolvedValueOnce(nodeRuntime("24.22.1"))
      .mockResolvedValueOnce(nodeRuntime("26.12.1"));

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      acceptNodeVersion: (version) => version?.startsWith("26.") === true,
    });

    expect(result).toMatchObject({
      path: targetCompatibleNode,
      version: "26.12.1",
      status: "supported",
    });
  });

  it("returns undefined from Bun when the only system Node is unsupported", async () => {
    mockNodePathPresent(darwinNode);
    const execFile = vi
      .spyOn(processExec, "runExec")
      .mockResolvedValue(nodeRuntime("22.22.2", null));

    const result = await preferredNode({
      execPath: "/Users/test/.bun/bin/bun",
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      darwinNode,
      [expect.stringMatching(/daemon-runtime-probe\.mjs$/), "node", ""],
      { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
    );
  });
});

describe("resolvePreferredBunPath", () => {
  it("returns undefined without probing missing Bun candidates", async () => {
    fsMocks.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const execFile = vi.spyOn(processExec, "runExec").mockRejectedValue(new Error("spawn EACCES"));
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "execPath", "get").mockReturnValue("/fixture/other");
    const result = resolvePreferredBunPath({
      env: {},
      runtime: "bun",
    });
    await expect(result).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  const windowsHome = "C:\\Users\\test";
  it.each([
    [
      "linux",
      "/usr/bin/node",
      { BUN_INSTALL: "/home/test/.bun", HOME: "/home/test" },
      "/home/test/.bun/bin/bun",
      "1.4.4",
    ],
    [
      "win32",
      "C:\\Program Files\\nodejs\\node.exe",
      { USERPROFILE: windowsHome },
      windowsHome + "\\.bun\\bin\\bun.exe",
      "1.4.4",
    ],
    ["freebsd", "/opt/custom/bun", {}, "/opt/custom/bun", "2.0.0"],
  ] as const)(
    "resolves Bun on %s from current %s and env %j",
    async (platform, current, env, path, version) => {
      const execFile = vi.spyOn(processExec, "runExec").mockResolvedValue(bunRuntime(version));
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.spyOn(process, "execPath", "get").mockReturnValue(current);
      expect(await resolvePreferredBunPath({ env, runtime: "bun" })).toBe(path);
      expect(execFile).toHaveBeenCalledWith(
        path,
        [expect.stringMatching(/daemon-runtime-probe\.mjs$/), "bun", ""],
        { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
      );
    },
  );

  it("probes Bun through the Gateway's SQLite library selection with a minimal env", async () => {
    const bunPath = "/opt/homebrew/bin/bun";
    const sqliteLibraryPath = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    // Apple's SQLite would report 3.54.0 here; the selected Homebrew library is what the Gateway opens.
    const execFile = vi
      .spyOn(processExec, "runExec")
      .mockResolvedValue(bunRuntime("1.4.4", true, "3.53.4", null, sqliteLibraryPath));
    const env = {
      PATH: "/opt/homebrew/bin",
      HOMEBREW_PREFIX: "/opt/homebrew",
      OPENCLAW_SQLITE_LIBRARY: sqliteLibraryPath,
      OPENCLAW_GATEWAY_TOKEN: "secret",
      NODE_OPTIONS: "--require /unrelated/preload.cjs",
    };

    await expect(resolveBunRuntimeInfo(bunPath, env)).resolves.toEqual({
      status: "supported",
      version: "1.4.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      sqliteVersion: "3.53.4",
      sqliteLibraryPath,
      nodeSharedSqlite: false,
    });
    expect(execFile).toHaveBeenCalledWith(
      bunPath,
      [expect.stringMatching(/daemon-runtime-probe\.mjs$/), "bun", ""],
      {
        logOutput: false,
        timeoutMs: 5_000,
        baseEnv: {
          PATH: env.PATH,
          HOMEBREW_PREFIX: env.HOMEBREW_PREFIX,
          OPENCLAW_SQLITE_LIBRARY: env.OPENCLAW_SQLITE_LIBRARY,
        },
      },
    );
  });

  it("reports an invalid SQLite library override instead of advising a Bun upgrade", async () => {
    vi.spyOn(processExec, "runExec").mockResolvedValue(
      bunRuntime("1.4.4", true, null, INVALID_SQLITE_OVERRIDE),
    );

    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "execPath", "get").mockReturnValue("/fixture/other");
    await expect(
      resolvePreferredBunPath({
        env: { PATH: "/opt/homebrew/bin:/usr/local/bin" },
        runtime: "bun",
      }),
    ).rejects.toThrow(INVALID_SQLITE_OVERRIDE);
  });
});

describe("resolveSystemNodeInfo", () => {
  const darwinNode = "/opt/homebrew/bin/node";

  it("warns about the failed probe without declaring the runtime unsupported", async () => {
    mockNodePathPresent(darwinNode);
    const cause = new Error("spawn EACCES");
    vi.spyOn(processExec, "runExec").mockRejectedValue(cause);
    const info = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
    });
    const warning = renderSystemNodeWarning(info, "/selected/node");
    expect(warning).toContain("check failed");
    expect(warning).toContain("EACCES");
    expect(warning).toContain(darwinNode);
    expect(warning).not.toContain("Install Node");
  });

  it("skips system-node candidates that resolve into version-manager paths", async () => {
    const homebrewOptNode = "/opt/homebrew/opt/node@24/bin/node";
    mockNodePathPresent(darwinNode, homebrewOptNode);
    mockNodeRealpath({
      [darwinNode]: "/Users/test/.nvm/versions/node/v24.14.1/bin/node",
      [homebrewOptNode]: homebrewOptNode,
    });

    const execFile = vi.spyOn(processExec, "runExec").mockResolvedValue(nodeRuntime("24.22.1"));

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
    });

    expect(result).toEqual({
      path: homebrewOptNode,
      sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      sqliteVersion: "3.51.3",
      version: "24.22.1",
      nodeSharedSqlite: false,
      status: "supported",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      homebrewOptNode,
      [expect.stringMatching(/daemon-runtime-probe\.mjs$/), "node", ""],
      { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
    );
  });

  it.each([
    ["22.23.3", "3.51.3", false, false, false, "node:sqlite truncates TEXT at embedded NUL"],
    ["18.19.0", null, true, false, false, undefined],
    ["24.22.1", "3.51.3", true, false, true, undefined],
    ["24.22.1", "3.51.2", true, false, false, undefined],
    ["24.22.1", "3.51.2", true, true, false, undefined],
  ] as const)(
    "warns for Node %s SQLite %s (TEXT=%s, shared=%s, supported=%s)",
    (version, sqlite, text, shared, supported, error) => {
      const selected = "/Users/me/.fnm/node-22/bin/node";
      const warning = renderSystemNodeWarning(
        {
          path: error || shared ? "/usr/bin/node" : darwinNode,
          version,
          sqliteVersion: sqlite,
          nodeSharedSqlite: shared,
          sqliteProbe: {
            available: sqlite !== null,
            version: sqlite,
            text,
            blob: true,
            json: true,
          },
          status: supported ? "supported" : "unsupported",
          capabilityError: error,
        },
        selected,
      );
      if (supported) {
        expect(warning).toBeNull();
      } else if (error) {
        expect(warning).toContain("System Node 22.23.3 at /usr/bin/node");
        expect(warning).toContain(error);
      } else if (!sqlite) {
        expect(warning).toBe(
          `System Node 18.19.0 at ${darwinNode} is outside the supported range. Using ${selected} for the daemon. Install Node >=24.16.0 <25, or >=26.1.0 (Node 26 recommended) from nodejs.org or Homebrew.`,
        );
      } else {
        expect(warning).toContain(
          shared ? "uses shared system SQLite 3.51.2" : "uses SQLite 3.51.2",
        );
        expect(warning).toContain("not WAL-reset-safe");
        if (shared) {
          expect(warning).toContain("Upgrade the system SQLite library");
          expect(warning).not.toContain("Install Node >=24.16.0");
        } else {
          expect(warning).toContain("Install Node >=24.16.0");
        }
      }
    },
  );

  it("uses validated custom Program Files roots on Windows", async () => {
    const customNode = "D:\\Programs\\nodejs\\node.exe";
    mockNodePathPresent(customNode);

    vi.spyOn(processExec, "runExec").mockResolvedValue(nodeRuntime("24.22.1"));
    const result = await resolveSystemNodeInfo({
      env: {
        ProgramFiles: "D:\\Programs",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
      },
      platform: "win32",
    });

    expect(result?.path).toBe(customNode);
  });
});
