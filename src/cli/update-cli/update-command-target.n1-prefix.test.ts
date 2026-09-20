import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";

const state = vi.hoisted(() => ({
  stop: new Error("stop after read-only target resolution"),
  selected: undefined as ResolvedGlobalInstallTarget | undefined,
  calls: [] as string[][],
}));
vi.mock("../../infra/update-global.js", async (original) => {
  const actual = await original<typeof import("../../infra/update-global.js")>();
  return {
    ...actual,
    createGlobalInstallEnv: async () => ({}),
    resolveGlobalInstallTarget: async (
      params: Parameters<typeof actual.resolveGlobalInstallTarget>[0],
    ) => {
      state.selected = await actual.resolveGlobalInstallTarget(params);
      throw state.stop;
    },
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
vi.mock("./shared.js", () => ({
  DEFAULT_PACKAGE_NAME: "openclaw",
  normalizeTag: () => null,
  readPackageName: async () => "openclaw",
  readPackageVersion: async () => "2026.9.4",
  resolveGlobalManager: async () => "npm",
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
import { resolveUpdateCommandTarget } from "./update-command-target.js";

beforeEach(() => {
  state.selected = undefined;
  state.calls = [];
});
const rootB = path.resolve(".n1-fixture/B/node_modules/openclaw");
const rootA = path.resolve(".n1-fixture/A/lib/node_modules/openclaw");
async function resolve(servicePlan: {
  rootRedirect: { root: string; previousRoot: string } | null;
  serviceRoot?: string;
  nodeRunner?: string;
}) {
  // Stop at the real resolver's result, before registry queries or any update mutation.
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
  const executor = {} as Parameters<typeof resolveUpdateCommandTarget>[4];
  await expect(
    resolveUpdateCommandTarget(
      { json: true, dryRun: true },
      recovery,
      undefined,
      prepared,
      executor,
      1000,
    ),
  ).rejects.toBe(state.stop);
  return state.selected;
}
it("keeps writable rebind target B without a recognized service Node instead of PATH npm A", async () => {
  const selected = await resolve({ rootRedirect: null, serviceRoot: rootA });
  expect(selected?.packageRoot).toBe(rootB);
  expect(selected?.directNodeModulesRoot).toBe(true);
  expect(state.calls.some((argv) => argv[1] === "root")).toBe(false);
});
it("keeps writable target B with an explicit service Node", async () => {
  expect(
    (await resolve({ rootRedirect: null, serviceRoot: rootA, nodeRunner: "/old/node" }))
      ?.packageRoot,
  ).toBe(rootB);
});
it("preserves protected-definition redirect to A", async () => {
  expect((await resolve({ rootRedirect: { root: rootA, previousRoot: rootB } }))?.packageRoot).toBe(
    rootA,
  );
});
it("does not reinterpret an unowned direct project as a selected global target", async () => {
  const selected = await resolve({ rootRedirect: null });
  expect(selected?.packageRoot).toBe(rootA);
  expect(state.calls.some((argv) => argv[1] === "root")).toBe(true);
});
