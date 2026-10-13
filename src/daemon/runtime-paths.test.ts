import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
// Daemon runtime path tests cover executable and config path resolution.
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
import { resolveNodeProgramArguments } from "./program-args.js";
import {
  renderSystemNodeWarning,
  resolveBunRuntimeInfo,
  resolvePreferredBunPath,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
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
  const result = await resolveBunRuntimeInfo("/usr/bin/bun", async () => ({
    stdout: "{}",
    stderr: "",
  }));
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
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(
        runtime === "node" ? nodeRuntime("20.0.0", null) : bunRuntime("1.3.0", false),
      )
      .mockRejectedValue(new Error("EACCES"));
    const resolve = runtime === "node" ? resolvePreferredNodePath : resolvePreferredBunPath;
    await expect(
      resolve({ env: {}, runtime, platform: "linux", execPath: "/fixture/other", execFile }),
    ).rejects.toThrow(/check failed.*EACCES/s);
  });
});

it("rejects a Bun node shim even when its emulated Node and SQLite versions are supported", async () => {
  mockNodePathPresent("/usr/bin/node");
  const metadata = JSON.parse(nodeRuntime("26.8.1").stdout);
  const result = await resolveSystemNodeInfo({
    env: {},
    platform: "linux",
    execFile: async () => ({
      stdout: JSON.stringify({ ...metadata, bunVersion: "1.4.3" }),
      stderr: "",
    }),
  });
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
      const execFile = vi.fn<NonNullable<Parameters<typeof resolveSystemNodeInfo>[0]["execFile"]>>(
        async (_file, args, options) => {
          expect(options.timeoutMs).toBe(5_000);
          let stdout = "";
          class CandidateDatabase extends DatabaseSync {
            override prepare(sql: string) {
              if (!lossless && sql === "SELECT text_value, blob_value, json_value FROM probe") {
                return super.prepare("SELECT 'a' AS text_value, blob_value, json_value FROM probe");
              }
              return super.prepare(sql);
            }
          }
          runInNewContext(args[1] ?? "", {
            require: () => ({ DatabaseSync: CandidateDatabase }),
            Buffer,
            Uint8Array,
            process: {
              versions: { node: version },
              stdout: {
                write: (value: string) => {
                  stdout += value;
                },
              },
            },
          });
          return { stdout, stderr: "" };
        },
      );
      const result = await resolveSystemNodeInfo({ env: {}, platform: "linux", execFile });
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
    const execFile = vi.fn().mockRejectedValue(new Error("spawn EACCES"));
    const install = async () => {
      const runtimePath = await preferredNode({
        platform: "linux",
        execPath: linuxSystemNode,
        execFile,
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

  it.each([{ platform: "win32", execPath: "D:\\Tools\\node24.exe", isNode: true }] as const)(
    "selects a supported current Node at $execPath on $platform",
    async ({ platform, execPath, isNode }) => {
      mockNodePathPresent();
      const execFile = vi.fn().mockResolvedValue(nodeRuntime("24.16.0"));

      const result = await resolvePreferredNodePath({
        env: {},
        runtime: "node",
        platform,
        execFile,
        execPath,
      });

      expect(result).toBe(isNode ? execPath : undefined);
      expect(execFile).toHaveBeenCalledTimes(isNode ? 1 : 0);
    },
  );

  const supported = nodeRuntime("24.16.0");
  const unsafeSqlite = nodeRuntime("24.17.0", "3.51.2");
  it("prefers the supported CLI runtime when repairing an unsupported service runtime", async () => {
    mockNodePathPresent(darwinNode);
    const execFile = vi.fn().mockResolvedValue(nodeRuntime("26.8.1"));
    expect(
      await preferredNode({
        execFile,
        execPath: fnmNode,
        preferCurrentExecPath: true,
      }),
    ).toBe(fnmNode);
  });
  it.each([
    [
      "retains safe nvm when system SQLite is unsafe",
      "linux",
      nvmNode,
      supported,
      unsafeSqlite,
      false,
    ],
  ] as const)("%s", async (_name, platform, execPath, current, system, preferSystem) => {
    const systemPath = platform === "linux" ? linuxSystemNode : darwinNode;
    mockNodePathPresent(systemPath);
    const execFile = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(system);
    const result = await preferredNode({ platform, execPath, execFile });
    expect(result).toBe(preferSystem ? systemPath : execPath);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it.each([["/home/test/.NVM/versions/node/v24/bin/node", true]] as const)(
    "preserves Linux runtime preference for %s (managed=%s)",
    async (execPath, managed) => {
      mockNodePathPresent(linuxSystemNode);
      const execFile = vi
        .fn()
        .mockResolvedValueOnce(nodeRuntime("24.16.0"))
        .mockResolvedValueOnce(nodeRuntime("24.16.0"));

      const result = await preferredNode({
        platform: "linux",
        execFile,
        execPath,
      });

      expect(result).toBe(managed ? linuxSystemNode : execPath);
      expect(execFile).toHaveBeenCalledTimes(managed ? 2 : 1);
    },
  );

  it("finds a later system Node accepted by the target engine", async () => {
    const targetCompatibleNode = "/opt/homebrew/opt/node/bin/node";
    mockNodePathPresent(darwinNode, targetCompatibleNode);
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(nodeRuntime("24.16.0"))
      .mockResolvedValueOnce(nodeRuntime("26.8.1"));

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
      acceptNodeVersion: (version) => version?.startsWith("26.") === true,
    });

    expect(result).toMatchObject({
      path: targetCompatibleNode,
      version: "26.8.1",
      status: "supported",
    });
  });

  it.each([
    {
      reason: "its version is unsupported",
      runtime: nodeRuntime("22.22.2", null),
    },
  ])("returns undefined from Bun when the only system Node $reason", async ({ runtime }) => {
    mockNodePathPresent(darwinNode);
    const execFile = vi.fn().mockResolvedValue(runtime);

    const result = await preferredNode({
      execFile,
      execPath: "/Users/test/.bun/bin/bun",
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      darwinNode,
      ["-e", expect.stringContaining("SELECT sqlite_version() AS version")],
      { encoding: "utf8", timeoutMs: 5_000, env: expect.any(Object) },
    );
  });
});

describe("resolvePreferredBunPath", () => {
  it.each(["ENOENT"])("distinguishes %s candidate access from missing Bun", async (code) => {
    fsMocks.access.mockRejectedValue(Object.assign(new Error(code), { code }));
    const execFile = vi.fn().mockRejectedValue(new Error("spawn EACCES"));
    const result = resolvePreferredBunPath({
      env: {},
      runtime: "bun",
      platform: "linux",
      execPath: "/fixture/other",
      execFile,
    });
    if (code === "ENOENT") {
      await expect(result).resolves.toBeUndefined();
      expect(execFile).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toThrow(/Bun runtime check failed.*EACCES/s);
    }
  });

  it("uses the stable BUN_INSTALL executable when Bun 1.4 provides WAL-safe node:sqlite", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    const execFile = vi.fn().mockResolvedValue(bunRuntime("1.4.0"));

    const result = await resolvePreferredBunPath({
      env: { BUN_INSTALL: "/home/test/.bun", HOME: "/home/test" },
      runtime: "bun",
      platform: "linux",
      execFile,
      execPath: "/usr/bin/node",
    });

    expect(result).toBe(bunPath);
    expect(execFile).toHaveBeenCalledWith(
      bunPath,
      ["-e", expect.stringContaining("SELECT sqlite_version() AS version")],
      { encoding: "utf8", timeoutMs: 5_000, env: expect.any(Object) },
    );
  });

  it("resolves the default Windows Bun executable", async () => {
    const bunPath = "C:\\Users\\test\\.bun\\bin\\bun.exe";
    const execFile = vi.fn().mockResolvedValue(bunRuntime("1.4.0"));

    const result = await resolvePreferredBunPath({
      env: { USERPROFILE: "C:\\Users\\test" },
      runtime: "bun",
      platform: "win32",
      execFile,
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });

    expect(result).toBe(bunPath);
  });

  it("uses the current Bun executable when no stable install path is available", async () => {
    const bunPath = "/opt/custom/bun";
    const execFile = vi.fn().mockResolvedValue(bunRuntime("2.0.0"));

    const result = await resolvePreferredBunPath({
      env: {},
      runtime: "bun",
      platform: "freebsd",
      execFile,
      execPath: bunPath,
    });

    expect(result).toBe(bunPath);
  });

  it("probes Bun through the Gateway's SQLite library selection with a minimal env", async () => {
    const bunPath = "/opt/homebrew/bin/bun";
    const sqliteLibraryPath = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    // Apple's SQLite would report 3.54.0 here; the selected Homebrew library is what the Gateway opens.
    const execFile = vi
      .fn()
      .mockResolvedValue(bunRuntime("1.4.2", true, "3.53.4", null, sqliteLibraryPath));
    const env = {
      PATH: "/opt/homebrew/bin",
      HOMEBREW_PREFIX: "/opt/homebrew",
      OPENCLAW_SQLITE_LIBRARY: sqliteLibraryPath,
      OPENCLAW_GATEWAY_TOKEN: "secret",
      NODE_OPTIONS: "--require /unrelated/preload.cjs",
    };

    await expect(resolveBunRuntimeInfo(bunPath, execFile, env)).resolves.toEqual({
      status: "supported",
      version: "1.4.2",
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
        encoding: "utf8",
        timeoutMs: 5_000,
        env: {
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
    const execFile = vi.fn<NonNullable<Parameters<typeof resolveBunRuntimeInfo>[1]>>(
      async (_file, args) => {
        let stdout = "";
        runInNewContext(args[1] ?? "", {
          require: (specifier: string) => {
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
          Buffer,
          Uint8Array,
          process: {
            versions: { bun: "1.4.2", node: "24.3.0" },
            stdout: {
              write: (value: string) => {
                stdout += value;
              },
            },
          },
        });
        return { stdout, stderr: "" };
      },
    );

    await expect(resolveBunRuntimeInfo("/opt/bun", execFile, {})).resolves.toMatchObject({
      version: "1.4.2",
      sqliteLibraryPath: path.resolve(selectedPath),
      sqliteProbe: { available: true },
    });
    expect(selectLibrary).toHaveBeenCalledOnce();
  });

  it("reports an invalid SQLite library override instead of advising a Bun upgrade", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValue(bunRuntime("1.4.2", true, null, INVALID_SQLITE_OVERRIDE));

    await expect(
      resolvePreferredBunPath({
        env: { PATH: "/opt/homebrew/bin:/usr/local/bin" },
        runtime: "bun",
        platform: "darwin",
        execPath: "/fixture/other",
        execFile,
      }),
    ).rejects.toThrow(INVALID_SQLITE_OVERRIDE);
  });
});

describe("resolveSystemNodeInfo", () => {
  const darwinNode = "/opt/homebrew/bin/node";

  it("warns about the failed probe without declaring the runtime unsupported", async () => {
    mockNodePathPresent(darwinNode);
    const cause = new Error("spawn EACCES");
    const info = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile: vi.fn().mockRejectedValue(cause),
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

    const execFile = vi.fn().mockResolvedValue(nodeRuntime("24.16.0"));

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
    });

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
      { encoding: "utf8", timeoutMs: 5_000, env: expect.any(Object) },
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
      {
        path: darwinNode,
        sqliteProbe: { available: false, version: null, text: true, blob: true, json: true },
        sqliteVersion: null,
        version: "18.19.0",
        nodeSharedSqlite: false,
        status: "unsupported",
      },
      selectedNode,
    );

    expect(warning).toBe(
      `System Node 18.19.0 at ${darwinNode} is outside the supported range. Using ${selectedNode} for the daemon. Install Node >=24.16.0 <25, or >=26.1.0 (Node 26 recommended) from nodejs.org or Homebrew.`,
    );
  });

  it("does not warn for a supported system Node version", () => {
    const warning = renderSystemNodeWarning(
      {
        path: darwinNode,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
        sqliteVersion: "3.51.3",
        version: "24.16.0",
        nodeSharedSqlite: false,
        status: "supported",
      },
      "/Users/me/.fnm/node-22/bin/node",
    );

    expect(warning).toBeNull();
  });

  it("renders a WAL safety warning for supported Node with unsafe SQLite", () => {
    const warning = renderSystemNodeWarning({
      path: darwinNode,
      sqliteProbe: { available: true, version: "3.51.2", text: true, blob: true, json: true },
      sqliteVersion: "3.51.2",
      version: "24.17.0",
      nodeSharedSqlite: false,
      status: "unsupported",
    });

    expect(warning).toContain("uses SQLite 3.51.2");
    expect(warning).toContain("not WAL-reset-safe");
    expect(warning).toContain("Install Node >=24.16.0");
  });

  it("renders a shared-system-SQLite remediation when Node is supported but the system library is unsafe", () => {
    const warning = renderSystemNodeWarning({
      path: "/usr/bin/node",
      sqliteProbe: { available: true, version: "3.51.2", text: true, blob: true, json: true },
      sqliteVersion: "3.51.2",
      version: "24.17.0",
      nodeSharedSqlite: true,
      status: "unsupported",
    });

    expect(warning).toContain("uses shared system SQLite 3.51.2");
    expect(warning).toContain("not WAL-reset-safe");
    expect(warning).toContain("Upgrade the system SQLite library");
    expect(warning).not.toContain("Install Node >=24.16.0");
  });

  it("uses validated custom Program Files roots on Windows", async () => {
    const customNode = "D:\\Programs\\nodejs\\node.exe";
    mockNodePathPresent(customNode);

    const execFile = vi.fn().mockResolvedValue(nodeRuntime("24.16.0"));
    const result = await resolveSystemNodeInfo({
      env: {
        ProgramFiles: "D:\\Programs",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
      },
      platform: "win32",
      execFile,
    });

    expect(result?.path).toBe(customNode);
  });
});
