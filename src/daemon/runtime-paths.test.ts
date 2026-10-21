import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      access: fsMocks.access,
      realpath: fsMocks.realpath,
    },
    access: fsMocks.access,
    realpath: fsMocks.realpath,
  };
});

import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
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

function preferredBun(options: Partial<Parameters<typeof resolvePreferredBunPath>[0]>) {
  return resolvePreferredBunPath({
    env: {},
    runtime: "bun",
    platform: "linux",
    execPath: "/fixture/other",
    ...options,
  });
}
function systemNode(options: Parameters<typeof resolveSystemNodeInfo>[0] = {}) {
  return resolveSystemNodeInfo({ env: {}, platform: "darwin", ...options });
}
function nodeInfo(
  overrides: Partial<
    Extract<
      NonNullable<Parameters<typeof renderSystemNodeWarning>[0]>,
      { status: "supported" | "unsupported" }
    >
  > = {},
) {
  return {
    path: "/opt/homebrew/bin/node",
    version: "24.16.0",
    sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
    sqliteVersion: "3.51.3",
    nodeSharedSqlite: false,
    status: "supported" as const,
    ...overrides,
  };
}
function runProbe(
  script: string,
  require: (specifier: string) => unknown,
  versions: Record<string, string>,
) {
  let stdout = "";
  runInNewContext(script, {
    require,
    Buffer,
    Uint8Array,
    process: {
      versions,
      stdout: {
        write: (value: string) => {
          stdout += value;
        },
      },
    },
  });
  return { stdout, stderr: "" };
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
    await expect(
      resolve({ env: {}, runtime, platform: "linux", execPath: "/fixture/other" }),
    ).rejects.toThrow(/check failed.*EACCES/s);
  });
});

it("rejects a Bun node shim even when its emulated Node and SQLite versions are supported", async () => {
  mockNodePathPresent("/usr/bin/node");
  const metadata = JSON.parse(nodeRuntime("26.8.1").stdout);
  vi.spyOn(processExec, "runExec").mockResolvedValue({
    stdout: JSON.stringify({ ...metadata, bunVersion: "1.4.3" }),
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
    ["24.16.0", false, "unsupported"],
    ["24.15.0+vendor.1", true, "supported"],
  ] as const)(
    "probes the selected binary's decoder on Node %s",
    async (version, lossless, expected) => {
      mockNodePathPresent("/usr/bin/node");
      vi.spyOn(processExec, "runExec").mockImplementation(async (_file, args, options) => {
        expect(options).toMatchObject({ timeoutMs: 5_000 });
        class CandidateDatabase extends DatabaseSync {
          override prepare(sql: string) {
            if (!lossless && sql === "SELECT text_value, blob_value, json_value FROM probe") {
              return super.prepare("SELECT 'a' AS text_value, blob_value, json_value FROM probe");
            }
            return super.prepare(sql);
          }
        }
        return runProbe(args[1] ?? "", () => ({ DatabaseSync: CandidateDatabase }), {
          node: version,
        });
      });
      const result = await resolveSystemNodeInfo({ env: {}, platform: "linux" });
      expect(result).toMatchObject({
        status: expected,
        version,
        sqliteProbe: { text: lossless, blob: true, json: true },
      });
    },
  );

  const darwinNode = "/opt/homebrew/bin/node";
  const fnmNode = "/Users/test/.fnm/node-versions/v24.16.0/installation/bin/node";
  const linuxSystemNode = "/usr/bin/node";
  const nvmNode = "/home/test/.nvm/versions/node/v24.16.0/bin/node";

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

  it.each([
    {
      name: "current versioned Windows executable",
      present: [],
      options: { platform: "win32", execPath: "D:\\Tools\\node24.exe" },
      versions: [["24.16.0", "3.51.3"]],
      expected: "D:\\Tools\\node24.exe",
    },
    {
      name: "preferred CLI runtime for repair",
      present: [darwinNode],
      options: { execPath: fnmNode, preferCurrentExecPath: true },
      versions: [["26.8.1", "3.51.3"]],
      expected: fnmNode,
    },
    {
      name: "safe nvm over unsafe system SQLite",
      present: [linuxSystemNode],
      options: { platform: "linux", execPath: nvmNode },
      versions: [
        ["24.16.0", "3.51.3"],
        ["24.17.0", "3.51.2"],
      ],
      expected: nvmNode,
    },
    {
      name: "system Node over uppercase NVM",
      present: [linuxSystemNode],
      options: { platform: "linux", execPath: "/home/test/.NVM/versions/node/v24/bin/node" },
      versions: [
        ["24.16.0", "3.51.3"],
        ["24.16.0", "3.51.3"],
      ],
      expected: linuxSystemNode,
    },
  ] as const)("selects $name", async ({ present, options, versions, expected }) => {
    mockNodePathPresent(...present);
    const execFile = vi.spyOn(processExec, "runExec");
    for (const [version, sqlite] of versions) {
      execFile.mockResolvedValueOnce(nodeRuntime(version, sqlite));
    }
    expect(await preferredNode(options)).toBe(expected);
    expect(execFile).toHaveBeenCalledTimes(versions.length);
  });

  it("finds a later system Node accepted by the target engine", async () => {
    const targetCompatibleNode = "/opt/homebrew/opt/node/bin/node";
    mockNodePathPresent(darwinNode, targetCompatibleNode);
    vi.spyOn(processExec, "runExec")
      .mockResolvedValueOnce(nodeRuntime("24.16.0"))
      .mockResolvedValueOnce(nodeRuntime("26.8.1"));

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      acceptNodeVersion: (version) => version?.startsWith("26.") === true,
    });

    expect(result).toMatchObject({
      path: targetCompatibleNode,
      version: "26.8.1",
      status: "supported",
    });
  });

  it("returns undefined from Bun when the only system Node is unsupported", async () => {
    mockNodePathPresent(darwinNode);
    const execFile = vi
      .spyOn(processExec, "runExec")
      .mockResolvedValue(nodeRuntime("22.22.2", null));
    expect(await preferredNode({ execPath: "/Users/test/.bun/bin/bun" })).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      darwinNode,
      ["-e", expect.stringContaining("SELECT sqlite_version() AS version")],
      { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
    );
  });
});

describe("resolvePreferredBunPath", () => {
  it("returns undefined without probing missing Bun candidates", async () => {
    fsMocks.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const execFile = vi.spyOn(processExec, "runExec").mockRejectedValue(new Error("spawn EACCES"));
    const result = preferredBun({ execPath: "/fixture/other" });
    await expect(result).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "stable BUN_INSTALL",
      env: { BUN_INSTALL: "/home/test/.bun", HOME: "/home/test" },
      platform: "linux",
      execPath: "/usr/bin/node",
      version: "1.4.3",
      expected: "/home/test/.bun/bin/bun",
    },
    {
      name: "Windows default",
      env: { USERPROFILE: "C:\\Users\\test" },
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      version: "1.4.3",
      expected: "C:\\Users\\test\\.bun\\bin\\bun.exe",
    },
    {
      name: "current Bun without a stable install",
      env: {},
      platform: "freebsd",
      execPath: "/opt/custom/bun",
      version: "2.0.0",
      expected: "/opt/custom/bun",
    },
  ] as const)("selects $name", async ({ name, version, expected, ...options }) => {
    const execFile = vi.spyOn(processExec, "runExec").mockResolvedValue(bunRuntime(version));
    expect(await preferredBun(options)).toBe(expected);
    if (name === "stable BUN_INSTALL") {
      expect(execFile).toHaveBeenCalledWith(
        expected,
        ["-e", expect.stringContaining("SELECT sqlite_version() AS version")],
        { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
      );
    }
  });

  it("probes Bun through the Gateway's SQLite library selection with a minimal env", async () => {
    const bunPath = "/opt/homebrew/bin/bun";
    const sqliteLibraryPath = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    // Apple's SQLite would report 3.54.0 here; the selected Homebrew library is what the Gateway opens.
    const execFile = vi
      .spyOn(processExec, "runExec")
      .mockResolvedValue(bunRuntime("1.4.3", true, "3.53.4", null, sqliteLibraryPath));
    const env = {
      PATH: "/opt/homebrew/bin",
      HOMEBREW_PREFIX: "/opt/homebrew",
      OPENCLAW_SQLITE_LIBRARY: sqliteLibraryPath,
      OPENCLAW_GATEWAY_TOKEN: "secret",
      NODE_OPTIONS: "--require /unrelated/preload.cjs",
    };

    await expect(resolveBunRuntimeInfo(bunPath, env)).resolves.toEqual({
      status: "supported",
      version: "1.4.3",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      sqliteVersion: "3.53.4",
      sqliteLibraryPath,
      nodeSharedSqlite: false,
    });
    const selectionModule = fileURLToPath(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.bunSqliteLibrary),
    );
    expect(execFile).toHaveBeenCalledWith(
      bunPath,
      [
        "-e",
        expect.stringContaining(
          `require(${JSON.stringify(selectionModule)}).ensureSqliteLibrarySelected`,
        ),
      ],
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

  it("resolves the selected library path in the Bun probe before returning it", async () => {
    const selectedPath = "custom homebrew/opt/sqlite/lib/libsqlite3.dylib";
    const selectionModule = fileURLToPath(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.bunSqliteLibrary),
    );
    const selectLibrary = vi.fn(() => ({ path: selectedPath }));
    vi.spyOn(processExec, "runExec").mockImplementation(async (_file, args) => {
      return runProbe(
        args[1] ?? "",
        (specifier: string) => {
          if (specifier === selectionModule) {
            return { ensureSqliteLibrarySelected: selectLibrary };
          }
          if (specifier === "node:path") {
            return path;
          }
          if (specifier === "node:sqlite") {
            expect(selectLibrary).toHaveBeenCalledOnce();
            return { DatabaseSync };
          }
          throw new Error(`Unexpected probe import: ${specifier}`);
        },
        { bun: "1.4.3", node: "24.3.0" },
      );
    });

    await expect(resolveBunRuntimeInfo("/opt/bun", {})).resolves.toMatchObject({
      version: "1.4.3",
      sqliteLibraryPath: path.resolve(selectedPath),
      sqliteProbe: { available: true },
    });
    expect(selectLibrary).toHaveBeenCalledOnce();
  });

  it("reports an invalid SQLite library override instead of advising a Bun upgrade", async () => {
    vi.spyOn(processExec, "runExec").mockResolvedValue(
      bunRuntime("1.4.3", true, null, INVALID_SQLITE_OVERRIDE),
    );

    await expect(
      preferredBun({
        env: { PATH: "/opt/homebrew/bin:/usr/local/bin" },
        platform: "darwin",
        execPath: "/fixture/other",
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
    const info = await systemNode();
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

    const execFile = vi.spyOn(processExec, "runExec").mockResolvedValue(nodeRuntime("24.16.0"));

    const result = await systemNode();

    expect(result).toEqual({
      path: homebrewOptNode,
      sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      sqliteVersion: "3.51.3",
      version: "24.16.0",
      nodeSharedSqlite: false,
      status: "supported",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      homebrewOptNode,
      ["-e", expect.stringContaining("SELECT sqlite_version() AS version")],
      { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
    );
  });

  it("names the system executable when its SQLite TEXT capability fails", () => {
    const warning = renderSystemNodeWarning({
      path: "/usr/bin/node",
      version: "22.23.3",
      sqliteVersion: "3.51.3",
      sqliteProbe: { available: true, version: "3.51.3", text: false, blob: true, json: true },
      nodeSharedSqlite: false,
      status: "unsupported",
      capabilityError: "node:sqlite truncates TEXT at embedded NUL",
    });
    expect(warning).toContain("System Node 22.23.3 at /usr/bin/node");
    expect(warning).toContain("node:sqlite truncates TEXT at embedded NUL");
  });

  it("reports a known unsupported system Node version", () => {
    const selectedNode = "/Users/me/.fnm/node-22/bin/node";
    const warning = renderSystemNodeWarning(
      nodeInfo({
        sqliteProbe: { available: false, version: null, text: true, blob: true, json: true },
        sqliteVersion: null,
        version: "18.19.0",
        status: "unsupported",
      }),
      selectedNode,
    );

    expect(warning).toBe(
      `System Node 18.19.0 at ${darwinNode} is outside the supported range. Using ${selectedNode} for the daemon. Install Node >=24.16.0 <25, or >=26.1.0 (Node 26 recommended) from nodejs.org or Homebrew.`,
    );
  });

  it("does not warn for a supported system Node version", () => {
    const warning = renderSystemNodeWarning(nodeInfo(), "/Users/me/.fnm/node-22/bin/node");

    expect(warning).toBeNull();
  });

  it.each([false, true])("renders unsafe SQLite remediation (shared=%s)", (shared) => {
    const warning = renderSystemNodeWarning(
      nodeInfo({
        path: shared ? "/usr/bin/node" : darwinNode,
        sqliteProbe: { available: true, version: "3.51.2", text: true, blob: true, json: true },
        sqliteVersion: "3.51.2",
        version: "24.17.0",
        nodeSharedSqlite: shared,
        status: "unsupported",
      }),
    );
    expect(warning).toContain(shared ? "uses shared system SQLite 3.51.2" : "uses SQLite 3.51.2");
    expect(warning).toContain("not WAL-reset-safe");
    if (shared) {
      expect(warning).toContain("Upgrade the system SQLite library");
      expect(warning).not.toContain("Install Node >=24.16.0");
    } else {
      expect(warning).toContain("Install Node >=24.16.0");
    }
  });

  it("uses validated custom Program Files roots on Windows", async () => {
    const customNode = "D:\\Programs\\nodejs\\node.exe";
    mockNodePathPresent(customNode);

    vi.spyOn(processExec, "runExec").mockResolvedValue(nodeRuntime("24.16.0"));
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
