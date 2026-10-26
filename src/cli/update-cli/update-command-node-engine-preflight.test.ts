import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateGlobal from "../../infra/update-global.js";
import { defaultRuntime } from "../../runtime.js";
import * as shared from "./shared.js";
import { runtimeFixture } from "./update-command-fixtures.test-support.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as runtimeRecovery from "./update-command-node-runtime-resolution.js";
import * as packageUpdate from "./update-command-package.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const engine = ">=24.22.1 <25 || >=26.12.1";

it.each([
  ["npm", "24.20.0"],
  ["pnpm", "24.21.0"],
  ["bun", "26.10.0"],
] as const)(
  "refuses %s before fresh-profile staging under service Node %s",
  async (manager, version) => {
    stubNodeRuntime();
    const serviceNode = path.join(path.dirname(fixture.root), "nix/store/old-nodejs/bin/node");
    fixture.managedServiceNodeRunner = serviceNode;
    vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue(manager);
    vi.mocked(updateGlobal.resolveGlobalInstallTarget).mockResolvedValue({
      manager,
      command: manager,
      globalRoot: path.dirname(fixture.root),
      packageRoot: fixture.root,
      ...(manager === "npm"
        ? { npmOwner: { version: "11.10.0", lifecyclePolicy: "unflagged" } }
        : {}),
    });
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockResolvedValue(
      runtimeFixture(version, "3.53.0"),
    );
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      version: "2026.10.6",
      nodeEngine: engine,
    });
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: "2026.10.6" });
    const provision = vi.spyOn(runtimeRecovery, "resolveTargetNodeRuntime");
    const manifest = fs.readFileSync(path.join(fixture.root, "package.json"));

    await expect(updateCommand({ tag: "2026.10.6", yes: true, json: true })).rejects.toMatchObject({
      code: 1,
    });

    const result = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
    expect(result).toMatchObject({ reason: "preflight-node-runtime-incompatible" });
    const output = JSON.stringify(result);
    expect(output).toContain(`Node ${version}`);
    expect(output).toContain(engine);
    expect(output).toContain("24.22.1");
    expect(output).toContain(serviceNode);
    expect(output).toContain("service definition");
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.root, "package.json"))).toEqual(manifest);
  },
);
