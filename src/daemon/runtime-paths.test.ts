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

const mockRuntime = (result = nodeRuntime("24.16.0")) =>
  vi.spyOn(processExec, "runExec").mockResolvedValue(result);

function runProbe(
  script: string,
  versions: { node: string; bun?: string },
  require: (specifier: string) => unknown,
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

function expectSqliteProbe(execFile: ReturnType<typeof mockRuntime>, executable: string) {
  expect(execFile).toHaveBeenCalledWith(
    executable,
    ["-e", expect.stringContaining("SELECT sqlite_version() AS version")],
    { logOutput: false, timeoutMs: 5_000, baseEnv: expect.any(Object) },
  );
}

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

function preferredBun(options: Parameters<typeof resolvePreferredBunPath>[0]) {
  return resolvePreferredBunPath({ env: {}, runtime: "bun", platform: "linux", ...options });
}

type ProbedNode = Exclude<
  NonNullable<Parameters<typeof renderSystemNodeWarning>[0]>,
  { status: "probe-failed" }
>;
function systemNode(overrides: Partial<ProbedNode>): ProbedNode {
  return {
    path: "/opt/homebrew/bin/node",
    sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
    sqliteVersion: "3.51.3",
    version: "24.16.0",
    nodeSharedSqlite: false,
    status: "supported" as const,
    ...overrides,
  };
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
      ...["node", "bun"].flatMap((name) => [`/usr/local/bin/${name}`, `/usr/bin/${name}`]),
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
        return runProbe(args[1] ?? "", { node: version }, () => ({
          DatabaseSync: CandidateDatabase,
        }));
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

  const supported = nodeRuntime("24.16.0");
  const unsafeSqlite = nodeRuntime("24.17.0", "3.51.2");
  const windowsNode = "D:\\Tools\\node24.exe";
  const uppercaseNvm = "/home/test/.NVM/versions/node/v24/bin/node";
  it.each([
    [windowsNode, "win32", [supported], false, false],
    [fnmNode, "darwin", [nodeRuntime("26.8.1")], true, false],
    [nvmNode, "linux", [supported, unsafeSqlite], false, false],
    [uppercaseNvm, "linux", [supported, supported], false, true],
  ] as const)(
    "selects Node for %s (%s)",
    async (execPath, platform, probes, preferCurrentExecPath, selectSystem) => {
      const systemPath = platform === "darwin" ? darwinNode : linuxSystemNode;
      mockNodePathPresent(...(platform === "win32" ? [] : [systemPath]));
      const execFile = vi.spyOn(processExec, "runExec");
      for (const probe of probes) {
        execFile.mockResolvedValueOnce(probe);
      }
      expect(await preferredNode({ platform, execPath, preferCurrentExecPath })).toBe(
        selectSystem ? systemPath : execPath,
      );
      expect(execFile).toHaveBeenCalledTimes(probes.length);
    },
  );

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

  it("returns undefined from Bun when the only system Node version is unsupported", async () => {
    mockNodePathPresent(darwinNode);
    const execFile = mockRuntime(nodeRuntime("22.22.2", null));
    expect(await preferredNode({ execPath: "/Users/test/.bun/bin/bun" })).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expectSqliteProbe(execFile, darwinNode);
  });
});

describe("resolvePreferredBunPath", () => {
  it("distinguishes ENOENT candidate access from missing Bun", async () => {
    fsMocks.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const execFile = vi.spyOn(processExec, "runExec").mockRejectedValue(new Error("spawn EACCES"));
    await expect(preferredBun({ execPath: "/fixture/other" })).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  const bunHome = "/home/test/.bun";
  const windowsHome = "C:\\Users\\test";
  const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
  it.each<{
    platform: NodeJS.Platform;
    version: string;
    bunPath: string;
    execPath: string;
    env: Record<string, string>;
  }>`
    platform     | version    | bunPath                                 | execPath             | env
    ${"linux"}   | ${"1.4.3"} | ${`${bunHome}/bin/bun`}                 | ${"/usr/bin/node"}   | ${{ BUN_INSTALL: bunHome, HOME: "/home/test" }}
    ${"win32"}   | ${"1.4.3"} | ${`${windowsHome}\\.bun\\bin\\bun.exe`} | ${windowsNode}       | ${{ USERPROFILE: windowsHome }}
    ${"freebsd"} | ${"2.0.0"} | ${"/opt/custom/bun"}                    | ${"/opt/custom/bun"} | ${{}}
  `(
    "selects $platform Bun $version at $bunPath",
    async ({ platform, version, bunPath, execPath, env }) => {
      const execFile = mockRuntime(bunRuntime(version));
      expect(await preferredBun({ platform, execPath, env })).toBe(bunPath);
      expectSqliteProbe(execFile, bunPath);
    },
  );

  it("probes Bun through the Gateway's SQLite library selection with a minimal env", async () => {
    const bunPath = "/opt/homebrew/bin/bun";
    const sqliteLibraryPath = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    // Apple's SQLite would report 3.54.0 here; the selected Homebrew library is what the Gateway opens.
    const execFile = mockRuntime(bunRuntime("1.4.3", true, "3.53.4", null, sqliteLibraryPath));
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
      return runProbe(args[1] ?? "", { bun: "1.4.3", node: "24.3.0" }, (specifier) => {
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
      });
    });

    await expect(resolveBunRuntimeInfo("/opt/bun", {})).resolves.toMatchObject({
      version: "1.4.3",
      sqliteLibraryPath: path.resolve(selectedPath),
      sqliteProbe: { available: true },
    });
    expect(selectLibrary).toHaveBeenCalledOnce();
  });

  it("reports an invalid SQLite library override instead of advising a Bun upgrade", async () => {
    mockRuntime(bunRuntime("1.4.3", true, null, INVALID_SQLITE_OVERRIDE));

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
    const info = await resolveSystemNodeInfo({ env: {}, platform: "darwin" });
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

    const execFile = mockRuntime();

    const result = await resolveSystemNodeInfo({ env: {}, platform: "darwin" });
    expect(result).toEqual(systemNode({ path: homebrewOptNode }));
    expect(execFile).toHaveBeenCalledTimes(1);
    expectSqliteProbe(execFile, homebrewOptNode);
  });

  const selectedNode = "/Users/me/.fnm/node-22/bin/node";
  const unsupportedWarning = `System Node 18.19.0 at ${darwinNode} is outside the supported range. Using ${selectedNode} for the daemon. Install Node >=24.16.0 <25, or >=26.1.0 (Node 26 recommended) from nodejs.org or Homebrew.`;
  const unsupportedNode = systemNode({
    sqliteProbe: { available: false, version: null, text: true, blob: true, json: true },
    sqliteVersion: null,
    version: "18.19.0",
    status: "unsupported",
  });
  const textError = "node:sqlite truncates TEXT at embedded NUL";
  const unsafeLibrary = systemNode({
    sqliteProbe: { available: true, version: "3.51.2", text: true, blob: true, json: true },
    sqliteVersion: "3.51.2",
    version: "24.17.0",
    status: "unsupported",
  });
  const textFailure = systemNode({
    path: "/usr/bin/node",
    version: "22.23.3",
    status: "unsupported",
    capabilityError: textError,
    sqliteProbe: { available: true, version: "3.51.3", text: false, blob: true, json: true },
  });
  it.each<{
    node: ProbedNode;
    selected?: string;
    exact?: string | null;
    included: string[];
    excluded: string[];
  }>`
    node                                                                   | selected        | exact                 | included                                                                                           | excluded
    ${systemNode({})}                                                      | ${selectedNode} | ${null}               | ${[]}                                                                                              | ${[]}
    ${unsupportedNode}                                                     | ${selectedNode} | ${unsupportedWarning} | ${[]}                                                                                              | ${[]}
    ${textFailure}                                                         | ${undefined}    | ${undefined}          | ${["System Node 22.23.3 at /usr/bin/node", textError]}                                             | ${[]}
    ${unsafeLibrary}                                                       | ${undefined}    | ${undefined}          | ${["uses SQLite 3.51.2", "not WAL-reset-safe", "Install Node >=24.16.0"]}                          | ${[]}
    ${{ ...unsafeLibrary, path: "/usr/bin/node", nodeSharedSqlite: true }} | ${undefined}    | ${undefined}          | ${["uses shared system SQLite 3.51.2", "not WAL-reset-safe", "Upgrade the system SQLite library"]} | ${["Install Node >=24.16.0"]}
  `(
    "renders SQLite remediation for $node.path ($node.version)",
    ({ node, selected, exact, included, excluded }) => {
      const warning = renderSystemNodeWarning(node, selected);
      if (exact !== undefined) {
        expect(warning).toBe(exact);
      }
      for (const text of included) {
        expect(warning).toContain(text);
      }
      for (const text of excluded) {
        expect(warning).not.toContain(text);
      }
    },
  );

  it("uses validated custom Program Files roots on Windows", async () => {
    const customNode = "D:\\Programs\\nodejs\\node.exe";
    mockNodePathPresent(customNode);

    mockRuntime();
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
