import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), passive: vi.fn(), read: vi.fn() }));
vi.mock("../../infra/upgrade-recipes/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/upgrade-recipes/catalog.js")>()),
  authenticateUpgradeRecipeCatalog: mocks.authenticate,
}));
vi.mock("../../infra/upgrade-recipes/maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/upgrade-recipes/maintenance.js")>()),
  readUpgradeRecipeMaintenanceReceipt: mocks.read,
}));
vi.mock("./plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plan.js")>()),
  updateRecipePlanCommand: mocks.passive,
}));
import { runUpgradeRecipeCommand } from "./recipe-command.js";

const originalExitCode = process.exitCode;
const roots: string[] = [];
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("help succeeds without authenticating metadata or inspecting installed configuration", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runUpgradeRecipeCommand(["--help"]);
  expect(process.exitCode).toBe(0);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.passive).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
});

it("keeps passive planning network-free and requires explicit verification admission", async () => {
  await runUpgradeRecipeCommand(["plan", "--installation", "/selected-installation", "--json"]);
  expect(mocks.passive).toHaveBeenCalledWith(
    expect.objectContaining({ installation: "/selected-installation", verify: false }),
  );
  await expect(
    runUpgradeRecipeCommand([
      "plan",
      "--installation",
      "/selected-installation",
      "--metadata-url",
      "https://example.invalid/metadata/",
    ]),
  ).rejects.toThrow("require --verify");
  await expect(
    runUpgradeRecipeCommand([
      "plan",
      "--installation",
      "/selected-installation",
      "--verify",
      "--catalog",
      "untrusted.json",
    ]),
  ).rejects.toThrow("cannot confer trust");
  expect(mocks.authenticate).not.toHaveBeenCalled();
});

it("status cannot confuse another installation receipt with the native caller's owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-native-status-"));
  roots.push(root);
  const pathname = path.join(root, "state.sqlite");
  await fs.writeFile(pathname, "sentinel");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  mocks.read.mockResolvedValue({
    binding: { installationKey: "/different-installation", runId: "old-owner" },
    phase: "commit-intent",
  });
  await expect(
    runUpgradeRecipeCommand([
      "status",
      "--installation",
      root,
      "--state-database",
      pathname,
      "--run",
      "old-owner",
    ]),
  ).rejects.toThrow("another installation");
  expect(output).not.toHaveBeenCalled();
  expect(await fs.readFile(pathname, "utf8")).toBe("sentinel");
});
