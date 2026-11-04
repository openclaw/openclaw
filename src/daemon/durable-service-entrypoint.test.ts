import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { resolveDurableServiceEntrypoint } from "./durable-service-entrypoint.js";

const { runGlobalPackageUpdateSteps, installedCopyErrors } = vi.hoisted(() => ({
  runGlobalPackageUpdateSteps: vi.fn(async (_params: { env?: NodeJS.ProcessEnv }) => ({
    failedStep: null,
  })),
  installedCopyErrors: vi.fn(
    async (_params: { packageRoot: string; expectedVersion?: string | null }) => ["missing"],
  ),
}));

// The real install env builder runs; package-manager steps and probes are recorded only.
// mock-isolation: record the npm install steps instead of running npm on the test host.
vi.mock("../infra/package-update-steps.js", () => ({ runGlobalPackageUpdateSteps }));
// mock-isolation: the fixture copy has no packed dist inventory to verify.
vi.mock("../infra/package-dist-inventory.js", () => ({
  collectPackageDistContentInventoryErrors: async () => [],
}));
// mock-isolation: no update step may spawn a process from this test.
vi.mock("../infra/update-runner-command.js", () => ({ runStep: vi.fn() }));
// mock-isolation: no command may spawn from this test.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));
// mock-isolation: keep npm prefix and installed-copy probes off the test host.
vi.mock("../infra/update-global.js", async () => ({
  createGlobalInstallEnv: (await import("../infra/update-global-env.js")).createGlobalInstallEnv,
  // No durable copy yet, and no npm probe on the test host.
  collectInstalledGlobalPackageErrors: installedCopyErrors,
  resolveGlobalInstallTarget: async () => ({ manager: "npm", command: "npm" }),
}));

describe("resolveDurableServiceEntrypoint", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-cli-")));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });
  const stateEnv = () => ({ OPENCLAW_STATE_DIR: path.join(root, "state") });
  const npxEntrypoint = () => {
    const npxPackage = path.join(root, ".npm", "_npx", "abc", "node_modules", "openclaw");
    fs.mkdirSync(npxPackage, { recursive: true });
    fs.writeFileSync(
      path.join(npxPackage, "package.json"),
      '{"name":"openclaw","version":"1.2.3"}',
    );
    fs.writeFileSync(path.join(npxPackage, "openclaw.mjs"), "");
    return path.join(npxPackage, "openclaw.mjs");
  };
  const durableCopy = () => {
    const prefix = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(root, "state", "npm"));
    const durable = path.join(prefix.globalRoot, "openclaw", "openclaw.mjs");
    fs.mkdirSync(path.dirname(durable), { recursive: true });
    fs.writeFileSync(durable, "");
    return durable;
  };

  it("does not reuse an unchecked copy while planning, and names the explicit reinstall", async () => {
    const entrypoint = npxEntrypoint();
    durableCopy();
    installedCopyErrors.mockResolvedValueOnce(["expected version 1.2.3, found 1.0.0"]);

    await expect(
      resolveDurableServiceEntrypoint(stateEnv(), { install: false }, entrypoint),
    ).rejects.toThrow(/found 1\.0\.0.*npx openclaw@1\.2\.3 gateway install --force/u);
    expect(installedCopyErrors).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "1.2.3" }),
    );
    expect(runGlobalPackageUpdateSteps).not.toHaveBeenCalled();
  });

  it("reuses a copy that matches this version and passes the integrity checks", async () => {
    const entrypoint = npxEntrypoint();
    const durable = durableCopy();
    installedCopyErrors.mockResolvedValueOnce([]);

    await expect(
      resolveDurableServiceEntrypoint(stateEnv(), { install: false }, entrypoint),
    ).resolves.toBe(durable);
    expect(runGlobalPackageUpdateSteps).not.toHaveBeenCalled();
  });

  it("runs npm lifecycle scripts with this Node, not an older one first on PATH", async () => {
    const npxPackage = path.join(root, ".npm", "_npx", "abc", "node_modules", "openclaw");
    fs.mkdirSync(npxPackage, { recursive: true });
    fs.writeFileSync(
      path.join(npxPackage, "package.json"),
      '{"name":"openclaw","version":"1.2.3"}',
    );
    fs.writeFileSync(path.join(npxPackage, "openclaw.mjs"), "");
    const olderNode = path.resolve("/run/current-system/sw/bin");

    await resolveDurableServiceEntrypoint(
      { OPENCLAW_STATE_DIR: path.join(root, "state"), PATH: olderNode },
      { install: true },
      path.join(npxPackage, "openclaw.mjs"),
    );

    const env = runGlobalPackageUpdateSteps.mock.calls[0]?.[0].env;
    expect(env?.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
      path.dirname(process.execPath),
      olderNode,
    ]);
  });
});
