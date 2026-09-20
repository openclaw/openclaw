import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { createFreeBsdPkgOwnershipInspection } from "../../infra/update-freebsd-pkg-ownership.js";
import { globalInstallArgs } from "../../infra/update-global.js";
import * as updateGlobal from "../../infra/update-global.js";
import { resolveNpmGlobalPrefixLayoutFromGlobalRoot } from "../../infra/update-npm-prefix.js";
import * as processOwner from "../../process/exec.js";
import * as shared from "./shared.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "routes package effects to the explicit target only for a bridge (bridge=%s)",
  async (bridge) => {
    const home = dirs.make("openclaw-bridge-target-routing-");
    const targetRoot = path.join(home, "old", "node_modules", "openclaw");
    const shellGlobalRoot = path.join(home, "executing-bridge", "lib", "node_modules");
    const shellRoot = path.join(shellGlobalRoot, "openclaw");
    for (const root of [targetRoot, shellRoot]) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
      );
    }
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "state", "openclaw.json"));
    vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
    vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({});
    vi.spyOn(updateCheck, "resolveNpmChannelTag").mockResolvedValue({
      tag: "latest",
      version: "2026.9.5",
    });
    vi.spyOn(packageMetadata, "fetchNpmPackageTargetStatus").mockResolvedValue({
      target: "2026.9.5",
      version: "2026.9.5",
      nodeEngine: null,
    });
    const commands = vi
      .spyOn(processOwner, "runCommandWithTimeout")
      .mockImplementation(async (argv) => {
        if (argv[0] === "npm" && argv[1] === "--version") {
          return {
            code: 0,
            signal: null,
            killed: false,
            termination: "exit" as const,
            stdout: "11.10.0\n",
            stderr: "",
          };
        }
        if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
          return {
            code: 0,
            signal: null,
            killed: false,
            termination: "exit" as const,
            stdout: shellGlobalRoot + "\n",
            stderr: "",
          };
        }
        throw new Error("Unexpected package-manager command: " + argv.join(" "));
      });
    const enter = vi.fn(async () => {
      throw new Error("Read-only target resolution must not acquire an executor");
    });
    // Admission authenticity is covered by the entry tests. Here the real target
    // resolver and global owner must turn the admitted selection into install args.
    const target = await resolveUpdateCommandTarget(
      {
        dryRun: true,
        json: true,
        ...(bridge ? { bridge: { kind: "update-bridge" as const } } : {}),
      },
      { triageTarget: { env: {} } },
      home,
      {
        startedAt: Date.now(),
        postCoreUpdateResume: false,
        postCoreUpdateChannel: undefined,
        timeoutMs: 1000,
        shouldRestart: false,
        requestedChannel: "stable",
        devTarget: undefined,
        controlPlaneUpdateSentinelMeta: null,
        discoveredRoot: targetRoot,
        installKind: "package",
        servicePlan: { rootRedirect: null },
        pkgOwnership: createFreeBsdPkgOwnershipInspection(1000),
      },
      { enter },
      1000,
    );
    expect(target?.packageInstallTarget?.packageRoot).toBe(bridge ? targetRoot : shellRoot);
    expect(target?.packageInstallTarget?.globalRoot).toBe(
      bridge ? path.dirname(targetRoot) : shellGlobalRoot,
    );
    const selected = target?.packageInstallTarget;
    if (!selected) {
      throw new Error("Missing package install target");
    }
    const layout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(selected.globalRoot, {
      allowDirectNodeModulesRoot: selected.directNodeModulesRoot,
    });
    expect(layout).not.toBeNull();
    const args = globalInstallArgs(
      selected,
      "openclaw@2026.9.5",
      selected.packageRoot,
      layout?.prefix,
    );
    const prefix = args.indexOf("--prefix");
    expect(prefix).toBeGreaterThan(-1);
    expect(args[prefix + 1]).toBe(
      bridge ? path.dirname(path.dirname(targetRoot)) : path.dirname(path.dirname(shellGlobalRoot)),
    );
    expect(enter).not.toHaveBeenCalled();
    expect(commands).toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, "state"))).toBe(false);
    expect(fs.readdirSync(targetRoot)).toEqual(["package.json"]);
    expect(fs.readdirSync(shellRoot)).toEqual(["package.json"]);
  },
);
