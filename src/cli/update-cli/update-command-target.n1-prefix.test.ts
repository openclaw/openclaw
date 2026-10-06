import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildRuntimeProbeEnv,
  resolveBunRuntimeInfo,
  resolveNodeRuntimeInfo,
} from "../../daemon/runtime-paths.js";
import { preparePackageUpdateRuntime } from "./update-command-node-runtime.js";

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  manager: "npm" as "npm" | "bun",
  sqliteText: true,
}));
vi.mock("../../infra/update-global.js", async (original) => {
  const actual = await original<typeof import("../../infra/update-global.js")>();
  return {
    ...actual,
    createGlobalInstallEnv: async () => ({}),
  };
});
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: async (argv: string[]) => {
    state.calls.push(argv);
    if (argv.includes("--version")) {
      return { code: 0, stdout: "12.0.0", stderr: "" };
    }
    if (argv[1] === "root" && argv[2] === "-g") {
      return { code: 0, stdout: path.resolve(".n1-fixture/A/lib/node_modules"), stderr: "" };
    }
    throw new Error(`Unexpected command in read-only resolver: ${argv.join(" ")}`);
  },
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  DEFAULT_PACKAGE_NAME: "openclaw",
  normalizeTag: () => null,
  readPackageName: async () => "openclaw",
  readPackageVersion: async () => "2026.9.4",
  resolveGlobalManager: async () => state.manager,
  resolveNodeRunner: () => "/current/node",
  resolveTargetVersion: vi.fn(),
  UpdatePreMutationError: class extends Error {},
}));
vi.mock("./update-command-config.js", () => ({
  readUpdateChannelConfig: async () => ({
    configSnapshot: { valid: true },
    storedChannel: "stable",
  }),
}));
vi.mock("../../infra/disk-space.js", () => ({ createLowDiskSpaceWarning: () => undefined }));
vi.mock("./update-command-package-destination.js", () => ({
  inspectNpmGlobalDestination: async () => ({ kind: "empty" }),
}));
vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveNpmChannelTag: async () => ({ tag: "latest", version: "2027.1.0" }),
}));
vi.mock("../../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: async () => ({ version: "2027.1.0", nodeEngine: ">=26.1.0" }),
}));
vi.mock("../../../node-sqlite.mjs", async (original) => ({
  ...(await original<typeof import("../../../node-sqlite.mjs")>()),
  detectCurrentSqliteCapabilities: async () => ({
    available: true,
    version: "3.53.4",
    text: state.sqliteText,
    blob: true,
    json: true,
  }),
}));
vi.mock("../../daemon/runtime-paths.js", async (original) => ({
  ...(await original<typeof import("../../daemon/runtime-paths.js")>()),
  resolveBunRuntimeInfo: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
}));
vi.mock("../../infra/package-update-activation-paths.js", async (original) => ({
  ...(await original<typeof import("../../infra/package-update-activation-paths.js")>()),
  capturePackageActivationRuntime: vi.fn((kind, executable) => ({
    kind,
    path: executable,
    identity: `fixture:${executable}`,
  })),
}));
vi.mock("./update-command-node-runtime-resolution.js", () => ({
  resolveTargetNodeRuntime: async () => undefined,
}));
import { resolveUpdateCommandTarget } from "./update-command-target.js";

beforeEach(() => {
  state.calls = [];
  state.manager = "npm";
  state.sqliteText = true;
  vi.mocked(resolveNodeRuntimeInfo).mockReset();
  vi.mocked(resolveBunRuntimeInfo)
    .mockReset()
    .mockResolvedValue({
      status: "supported",
      version: "1.4.3",
      sqliteVersion: "3.53.4",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    });
});
afterEach(() => vi.unstubAllGlobals());
const rootB = path.resolve(".n1-fixture/B/node_modules/openclaw");
const rootA = path.resolve(".n1-fixture/A/lib/node_modules/openclaw");
async function resolve(servicePlan: {
  rootRedirect: { root: string; previousRoot: string } | null;
  serviceRoot?: string;
  nodeRunner?: string;
}) {
  // Dry-run target resolution uses synthetic registry metadata and never mutates an install.
  const prepared = {
    discoveredRoot: rootB,
    installKind: "package",
    requestedChannel: null,
    timeoutMs: 1000,
    shouldRestart: true,
    servicePlan,
  } as Parameters<typeof resolveUpdateCommandTarget>[3];
  const recovery = { triageTarget: { root: rootB } } as Parameters<
    typeof resolveUpdateCommandTarget
  >[1];
  const executor = { enter: vi.fn(async () => ({ assertCurrent: vi.fn() })) };
  const target = await resolveUpdateCommandTarget(
    { json: true, dryRun: true },
    recovery,
    undefined,
    prepared,
    executor,
    1000,
  );
  if (!target) {
    throw new Error("Expected an admitted update target");
  }
  return target;
}
it.each(["writable rebind", "protected redirect", "unowned project"] as const)(
  "selects the package root for a %s",
  async (kind) => {
    const selected = await resolve({
      rootRedirect: kind === "protected redirect" ? { root: rootA, previousRoot: rootB } : null,
      ...(kind === "writable rebind" ? { serviceRoot: rootA } : {}),
    });
    expect(selected.packageInstallTarget?.packageRoot).toBe(
      kind === "writable rebind" ? rootB : rootA,
    );
    if (kind !== "protected redirect") {
      expect(state.calls.some((argv) => argv[1] === "root")).toBe(kind === "unowned project");
    }
    if (kind === "writable rebind") {
      expect(selected.packageInstallTarget?.directNodeModulesRoot).toBe(true);
      expect(selected.packageUpdateNodeRunner).toBe(
        process.versions.bun ? undefined : "/current/node",
      );
    }
  },
);
it("rejects a Bun-driven split-root update when the recorded service Node cannot run the target", async () => {
  vi.stubGlobal("process", {
    ...process,
    execPath: "/fixture/bun",
    versions: { ...process.versions, bun: "1.4.3" },
  });
  vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
    status: "supported",
    version: "24.16.0",
    sqliteVersion: "3.51.3",
    nodeSharedSqlite: false,
    sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
  });
  const target = await resolve({ rootRedirect: null, serviceRoot: rootA, nodeRunner: "/old/node" });
  const result = await preparePackageUpdateRuntime({
    ...target,
    shouldRestart: true,
    opts: { json: true },
    executor: { enter: async () => ({ assertCurrent: vi.fn() }) },
    timeoutMs: 1000,
    managedService: {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceNodeRunner: "/old/node",
      serviceUpdateVerdict: {
        kind: "owned",
        root: rootA,
        fingerprint: "fixture",
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      },
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining(
      "requires Node >=26.1.0; selected runtime is Node 24.16.0 at /old/node",
    ),
    failureFacts: [{ check: "node-runtime", code: "node-runtime-preflight" }],
  });
  expect(vi.mocked(resolveNodeRuntimeInfo).mock.calls.map(([runner]) => runner)).toEqual([
    "/old/node",
  ]);
});
it.each([
  { node: "24.16.0", sqliteText: true, admitted: false },
  { node: "26.1.0", sqliteText: false, admitted: false },
  { node: "26.1.0", sqliteText: true, admitted: true },
])(
  "checks updater Node $node (SQLite text=$sqliteText) before a Bun service-root update",
  async ({ node, sqliteText, admitted }) => {
    vi.stubGlobal(
      "process",
      Object.create(process, {
        execPath: { value: "/current/node" },
        versions: { value: { ...process.versions, node, bun: undefined } },
      }),
    );
    state.sqliteText = sqliteText;
    state.manager = "bun";
    const serviceRoot = path.resolve(".n1-fixture/service/install/global/node_modules/openclaw");
    const bun = "/service/bin/bun";
    const target = await resolve({
      rootRedirect: { root: serviceRoot, previousRoot: rootB },
      nodeRunner: bun,
    });
    expect(target.root).toBe(serviceRoot);
    expect(target.packageUpdateNodeRunner).toBe(bun);
    expect(target.packageInstallTarget).toMatchObject({
      manager: "bun",
      command: bun,
      packageRoot: serviceRoot,
    });
    const result = await preparePackageUpdateRuntime({
      ...target,
      shouldRestart: true,
      opts: { json: true },
      executor: { enter: async () => ({ assertCurrent: vi.fn() }) },
      timeoutMs: 1000,
    });
    expect(result).toMatchObject(
      admitted
        ? {
            ok: true,
            value: {
              nodeRunner: bun,
              activationRuntime: { kind: "bun", path: bun, identity: `fixture:${bun}` },
            },
          }
        : {
            ok: false,
            error: expect.stringContaining(
              `requires Node >=26.1.0; selected runtime is Node ${node}`,
            ),
            failureFacts: [{ check: "node-runtime", code: "node-runtime-preflight" }],
          },
    );
    expect(resolveBunRuntimeInfo).toHaveBeenCalledWith(
      bun,
      undefined,
      buildRuntimeProbeEnv(process.env),
    );
    expect(resolveNodeRuntimeInfo).not.toHaveBeenCalled();
  },
);
