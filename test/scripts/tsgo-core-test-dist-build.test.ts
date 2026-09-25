// Typed runtime preparation tests cover the runtime owners the prepare step restores.
import { describe, expect, it } from "vitest";
import { BUILD_ALL_STEPS, resolveBuildAllStep } from "../../scripts/build-all.mts";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import {
  buildTsgoCoreTestTypedRuntimeDist,
  listRestoredRuntimeSteps,
} from "../../scripts/lib/tsgo-core-test-dist-build.mts";

const recordingRunner = (
  calls: Array<{ args: string[]; cwd?: string; env: NodeJS.ProcessEnv }>,
  fail: (target: string) => number = () => 0,
) =>
  (async (params: { args: string[]; cwd?: string; env: NodeJS.ProcessEnv }) => {
    calls.push(params);
    return fail(params.args[3] ?? "");
  }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

/** Repo-relative script each preparation child drives, decoded from its file URL. */
const childTargets = (calls: Array<{ args: string[] }>, repoRoot = "/repo") =>
  calls.map((call) => {
    const url = new URL(call.args[3] ?? "");
    expect(url.protocol).toBe("file:");
    if (repoRoot.includes(" ")) {
      // A checkout path with spaces stays a percent-encoded file URL; a raw space
      // is what a Windows shell rejects when it routes the argument through cmd.exe.
      expect(url.pathname).toContain("%20");
      for (const arg of call.args) {
        expect(arg).not.toContain(repoRoot);
      }
    }
    return decodeURIComponent(url.pathname).slice(repoRoot.length + 1);
  });

describe("typed runtime declaration preparation", () => {
  it("restores the cleaned runtime artifacts through their canonical owners", async () => {
    expect((await listRestoredRuntimeSteps()).map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown-ai",
      "external-plugins:local-dist",
      "plugins:assets:copy",
      "runtime-postbuild",
    ]);
  });

  it("keeps every restored owner a step build-all still defines", async () => {
    for (const step of await listRestoredRuntimeSteps()) {
      expect(BUILD_ALL_STEPS).toContain(step);
    }
  });

  it("resolves the copied plugin assets through their node owner", async () => {
    const assetStep = (await listRestoredRuntimeSteps()).find(
      (step) => step.label === "plugins:assets:copy",
    );
    expect(assetStep).toBeDefined();
    if (!assetStep) {
      throw new Error("plugins:assets:copy owner is missing");
    }
    const resolved = resolveBuildAllStep(assetStep, {
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
    });
    expect(resolved.args.join(" ")).toContain("bundled-plugin-assets.mts");
  });

  it("exposes the preparation entry point for the shard runner", () => {
    expect(typeof buildTsgoCoreTestTypedRuntimeDist).toBe("function");
  });

  it("restores the assets build before the copy that reads its bundles", async () => {
    const labels = (await listRestoredRuntimeSteps()).map((step) => step.label);
    const buildIndex = labels.indexOf("plugins:assets:build");
    const copyIndex = labels.indexOf("plugins:assets:copy");
    // The copy phase runs each plugin's assetScripts.copy, which fails closed
    // with "Missing A2UI bundle assets" when the build phase has not written
    // them, so the producer has to come first.
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(copyIndex);
    expect(copyIndex).toBeLessThan(labels.indexOf("runtime-postbuild"));
  });

  it("restores the package build before the postbuild verification loads it", async () => {
    const labels = (await listRestoredRuntimeSteps()).map((step) => step.label);
    const packageIndex = labels.indexOf("tsdown-ai");
    // runtime-postbuild verifies the built plugin control-plane modules, which
    // import @openclaw/ai/dist, so the package build has to come first.
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(packageIndex).toBeLessThan(labels.indexOf("runtime-postbuild"));
  });

  it("keeps build-all's own order for the shared asset steps", () => {
    const labels = BUILD_ALL_STEPS.map((step) => step.label);
    expect(labels.indexOf("plugins:assets:build")).toBeLessThan(labels.indexOf("tsdown"));
    expect(labels.indexOf("plugins:assets:copy")).toBeLessThan(labels.indexOf("runtime-postbuild"));
  });

  it("launches every preparation child without a shell and keeps CLI metadata", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; shell?: boolean }> = [];
    const fakeRunner = (async (params: {
      args: string[];
      env: NodeJS.ProcessEnv;
      shell?: boolean;
    }) => {
      calls.push(params);
      return 0;
    }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

    const status = await buildTsgoCoreTestTypedRuntimeDist(
      { PATH: "/usr/bin" },
      "/repo",
      fakeRunner,
    );

    expect(status).toBe(0);
    // The compile, the five restored owners, and the declaration writer.
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      // A Windows shell routes arguments through cmd.exe, which rejects the
      // percent-encoded file URLs of a checkout path containing spaces.
      expect(call.shell).toBe(false);
      // The absent bundle stays a failure; only the producer may satisfy it.
      expect(call.env.OPENCLAW_A2UI_SKIP_MISSING).toBeUndefined();
    }
    expect(calls[0]?.env).toMatchObject({
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    });
    expect(calls[1]?.args.join(" ")).toContain("bundled-plugin-assets.mts");
    expect(calls[1]?.args.join(" ")).toContain("build");
    expect(calls.at(-1)?.args.join(" ")).toContain("write-typed-runtime-entry-dts.ts");
  });

  it("stops before restoring owners when the compile fails", async () => {
    const calls: unknown[] = [];
    const compileFails = (async (params: unknown) => {
      calls.push(params);
      return 7;
    }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

    const status = await buildTsgoCoreTestTypedRuntimeDist({}, "/repo", compileFails);

    expect(status).toBe(7);
    expect(calls).toHaveLength(1);
  });

  it("drives every child through the artifact entry in the measured order", async () => {
    const calls: Array<{ args: string[]; cwd?: string; env: NodeJS.ProcessEnv }> = [];
    const runner = recordingRunner(calls);

    const status = await buildTsgoCoreTestTypedRuntimeDist({}, "/repo with spaces", runner);

    expect(status).toBe(0);
    expect(childTargets(calls, "/repo with spaces")).toEqual([
      "scripts/tsdown-build.mts",
      "scripts/bundled-plugin-assets.mts",
      "scripts/tsdown-build.mts",
      "scripts/build-external-plugin-local-dist.mts",
      "scripts/bundled-plugin-assets.mts",
      "scripts/runtime-postbuild.mts",
      "scripts/write-typed-runtime-entry-dts.ts",
    ]);
    for (const call of calls) {
      // Every child runs the artifact entry, which owns the dist output lock.
      expect(call.args[1]).toMatch(/scripts[\\/]tsx\.mjs$/u);
      expect(call.args[2]).toMatch(/dist-artifact-ownership\.(?:mts|mjs|js)$/u);
      expect(call.cwd).toBe("/repo with spaces");
    }
    // The compile narrows the unified graph to the one config group it owns, and
    // the declaration writer takes no extra arguments.
    expect(calls[0]?.args.slice(4)).toEqual([
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
    ]);
    expect(calls.at(-1)?.args.slice(4)).toEqual([]);
    // The two asset phases are distinct children around the owners between them.
    expect(calls[1]?.args.slice(4)).toEqual(["--phase", "build"]);
    expect(calls[4]?.args.slice(4)).toEqual(["--phase", "copy"]);
  });

  it("hands every child the caller env and the flags its phase owns", async () => {
    const calls: Array<{ args: string[]; cwd?: string; env: NodeJS.ProcessEnv }> = [];
    const runner = recordingRunner(calls);

    const status = await buildTsgoCoreTestTypedRuntimeDist(
      { PATH: "/usr/bin", OPENCLAW_TEST_MARKER: "keep" },
      "/repo",
      runner,
    );

    expect(status).toBe(0);
    // The compile cleans the shared output roots, so it must not remove declared
    // outputs it cannot regenerate, and it must keep the precomputed CLI metadata
    // that none of the restored owners rewrites.
    expect(calls[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      OPENCLAW_TEST_MARKER: "keep",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    });
    // Each restored owner takes the node fallback, so none starts a package
    // manager child that would block on the shard runner's build lock.
    for (const call of calls.slice(1, 6)) {
      expect(call.env).toMatchObject({
        PATH: "/usr/bin",
        OPENCLAW_TEST_MARKER: "keep",
        OPENCLAW_BUILD_ALL_NO_PNPM: "1",
      });
    }
    // The declaration publish runs in the caller's env, without the build flags.
    expect(calls[6]?.env).toEqual({ PATH: "/usr/bin", OPENCLAW_TEST_MARKER: "keep" });
  });

  it("returns the declaration publish failure that stops the shard runner", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runner = recordingRunner(calls, (target) =>
      decodeURIComponent(target).endsWith("write-typed-runtime-entry-dts.ts") ? 5 : 0,
    );

    const status = await buildTsgoCoreTestTypedRuntimeDist({}, "/repo", runner);

    // The launcher returns this code before it runs any checker, so a publish
    // failure fails the job instead of type-checking a declaration-less tree.
    expect(status).toBe(5);
    expect(childTargets(calls)).toHaveLength(7);
    expect(childTargets(calls).at(-1)).toBe("scripts/write-typed-runtime-entry-dts.ts");
  });

  it("stops restoring owners after the first failing owner", async () => {
    const phases: string[] = [];
    const failingCopy = (async (params: { args: string[] }) => {
      const phase = params.args.join(" ");
      phases.push(phase);
      return phase.includes("bundled-plugin-assets.mts") && phase.includes("copy") ? 3 : 0;
    }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

    const status = await buildTsgoCoreTestTypedRuntimeDist({}, "/repo", failingCopy);

    expect(status).toBe(3);
    expect(phases.at(-1)).toContain("copy");
    expect(phases.some((phase) => phase.includes("write-typed-runtime-entry-dts.ts"))).toBe(false);
  });
});
