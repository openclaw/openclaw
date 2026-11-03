import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDurableServiceEntrypoint } from "./durable-service-entrypoint.js";

const { runGlobalPackageUpdateSteps } = vi.hoisted(() => ({
  runGlobalPackageUpdateSteps: vi.fn(async (_params: { env?: NodeJS.ProcessEnv }) => ({
    failedStep: null,
  })),
}));

// The real install env builder runs; package-manager steps and probes are recorded only.
vi.mock("../infra/package-update-steps.js", () => ({ runGlobalPackageUpdateSteps }));
vi.mock("../infra/package-dist-inventory.js", () => ({
  collectPackageDistContentInventoryErrors: async () => [],
}));
vi.mock("../infra/update-runner-command.js", () => ({ runStep: vi.fn() }));
vi.mock("../infra/update-global.js", async () => ({
  createGlobalInstallEnv: (await import("../infra/update-global-env.js")).createGlobalInstallEnv,
  // No durable copy yet, and no npm probe on the test host.
  collectInstalledGlobalPackageErrors: async () => ["missing"],
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
