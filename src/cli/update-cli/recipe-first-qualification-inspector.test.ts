import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admitReleaseQualificationChildInspector } from "./recipe-qualification.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const mock = vi.hoisted(() => ({ catalog: vi.fn(), authority: vi.fn(), current: vi.fn() }));
// mock-isolation: original signed-custody tests own actual runner/machine admission.
vi.mock("./update-recipe-context.js", async (original) => ({
  ...(await original<typeof import("./update-recipe-context.js")>()),
  resolveAuthenticatedRecipeUpdateCatalog: mock.catalog,
}));
// mock-isolation: exercise the fixed-flag policy without acquiring operator native leases.
vi.mock("./update-command-executor.js", async (original) => ({
  ...(await original<typeof import("./update-command-executor.js")>()),
  captureUpdateCommandExecutorAuthority: mock.authority,
}));
vi.mock("../../infra/upgrade-recipes/catalog.js", async (original) => ({
  ...(await original<typeof import("../../infra/upgrade-recipes/catalog.js")>()),
  assertUpgradeRecipeCatalogCurrent: mock.current,
}));
const originalArgv = process.execArgv;
const flag = "--inspect-brk=127.0.0.1:0";
const selected = () => {
  const recipe = approvedContext();
  recipe.releaseQualification = {
    purpose: "release-qualification",
    recipe: recipe.route.recipe,
    machineId: "a".repeat(32),
    bootId: "123e4567-e89b-42d3-a456-426614174000",
    mountNamespace: "mnt:[1]",
    pidNamespace: "pid:[1]",
  };
  return recipe;
};
const fence = { assertCurrent: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  process.execArgv = [flag];
  mock.authority.mockReturnValue({ installKey: selected().maintenance.binding.installationKey });
  mock.catalog.mockResolvedValue({});
});
afterEach(() => {
  process.execArgv = originalArgv;
});
it("admits precisely the fixed startup pause under live original custody", async () => {
  const recipe = selected();
  await expect(admitReleaseQualificationChildInspector(recipe, fence)).resolves.toBe(flag);
  expect(mock.catalog).toHaveBeenCalledWith(recipe);
  expect(mock.authority).toHaveBeenCalledTimes(2);
});
it.each([{ argv: [] }, { argv: ["--inspect=127.0.0.1:0"] }, { argv: ["--expose-gc"] }])(
  "does not propagate unrelated observations %j",
  async ({ argv }) => {
    process.execArgv = argv;
    await expect(
      admitReleaseQualificationChildInspector(selected(), fence),
    ).resolves.toBeUndefined();
    expect(mock.catalog).not.toHaveBeenCalled();
  },
);
it("refuses fixed observation on production", async () => {
  await expect(admitReleaseQualificationChildInspector(approvedContext(), fence)).rejects.toThrow(
    "custody",
  );
  expect(mock.catalog).not.toHaveBeenCalled();
});
it("refuses extra observed flags", async () => {
  process.execArgv = [flag, "--expose-gc"];
  await expect(admitReleaseQualificationChildInspector(selected(), fence)).rejects.toThrow(
    "custody",
  );
});
it.each(["custody revoked", "catalog expired"])("refuses %s", async (reason) => {
  mock.catalog.mockRejectedValue(new Error(reason));
  await expect(admitReleaseQualificationChildInspector(selected(), fence)).rejects.toThrow(reason);
});
it("refuses executor replacement across awaited catalog admission", async () => {
  mock.catalog.mockImplementation(async () => {
    mock.authority.mockReturnValue({ installKey: selected().maintenance.binding.installationKey });
    return {};
  });
  await expect(admitReleaseQualificationChildInspector(selected(), fence)).rejects.toThrow(
    "executor",
  );
});
it("reobserves exact argv after awaited admission", async () => {
  mock.catalog.mockImplementation(async () => {
    process.execArgv = [];
    return {};
  });
  await expect(admitReleaseQualificationChildInspector(selected(), fence)).rejects.toThrow(
    "observation",
  );
});
