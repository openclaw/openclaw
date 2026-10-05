import { describe, expect, it, vi } from "vitest";
import {
  assertRecipeUpdateBinding,
  assertRecipeUpdateEnvironment,
  assertRecipeUpdatePackageOwner,
} from "./update-recipe-context.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor.js")>()),
  captureUpdateCommandExecutorAuthority: (fence: { assertCurrent: () => void }) => {
    fence.assertCurrent();
    return { installKey: "/selected-install" };
  },
}));

describe("recipe update approval and native binding", () => {
  it("refuses native npm prefix, lifecycle policy, and launcher substitution", () => {
    const recipe = approvedContext();
    expect(() => assertRecipeUpdatePackageOwner(recipe, recipe.packageOwner)).not.toThrow();
    for (const changed of [
      { globalRoot: "/other-prefix/lib/node_modules" },
      { packageRoot: "/other-install" },
      { command: "/other-prefix/bin/npm" },
      { command: "npm" },
      { npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" as const } },
      { npmOwner: { version: "11.16.0", lifecyclePolicy: "unflagged" as const } },
      { npmOwner: { version: null, lifecyclePolicy: null } },
      { directNodeModulesRoot: true },
    ]) {
      expect(() =>
        assertRecipeUpdatePackageOwner(recipe, { ...recipe.packageOwner, ...changed }),
      ).toThrow();
    }
  });
  it("refuses an updater environment selecting different live state than the approved config reader", () => {
    const recipe = approvedContext();
    const selected = {
      OPENCLAW_STATE_DIR: recipe.maintenance.expected.stateRoot,
      OPENCLAW_CONFIG_PATH: recipe.maintenance.expected.configPath,
      OPENCLAW_PROFILE: recipe.maintenance.expected.profile,
    };
    expect(() => assertRecipeUpdateEnvironment(recipe, selected)).not.toThrow();
    for (const changed of [
      { OPENCLAW_STATE_DIR: "/other-state" },
      { OPENCLAW_CONFIG_PATH: "/other-state/config.json" },
      { OPENCLAW_PROFILE: "other" },
      { OPENCLAW_PROFILE: " default " },
      { OPENCLAW_PROFILE: "" },
    ]) {
      expect(() => assertRecipeUpdateEnvironment(recipe, { ...selected, ...changed })).toThrow();
    }
  });
  it("carries exact selected installation facts but still requires live native custody", () => {
    const recipe = approvedContext();
    const fence = { assertCurrent: vi.fn() };
    assertRecipeUpdateBinding(recipe, "/selected-install", "original", fence);
    expect(fence.assertCurrent).toHaveBeenCalled();
    expect(() =>
      assertRecipeUpdateBinding(recipe, "/retained-runner", "original", fence),
    ).toThrow();
    expect(() =>
      assertRecipeUpdateBinding(recipe, "/selected-install", "new-run", fence),
    ).toThrow();
  });

  it.each(["localArchivePath", "catalogDigest", "runner", "maintenance"] as const)(
    "refuses substituted %s even when the copied approved digest still matches the receipt",
    (field) => {
      const recipe = approvedContext();
      if (field === "localArchivePath") {
        recipe.localArchivePath = "/artifacts/other.tgz";
      } else if (field === "catalogDigest") {
        recipe.catalogDigest = "2".repeat(64);
      } else if (field === "runner") {
        recipe.runner.closureDigest = "2".repeat(64);
      } else {
        recipe.maintenance.expected.configSourceDigest = "2".repeat(64);
      }
      expect(() => assertRecipeUpdateBinding(recipe, "/selected-install", "original")).toThrow();
    },
  );

  it("never interprets an expired native fence or report-only plan as mutation authority", () => {
    const recipe = approvedContext();
    expect(() =>
      assertRecipeUpdateBinding(recipe, "/selected-install", "original", {
        assertCurrent: () => {
          throw new Error("native custody lost");
        },
      }),
    ).toThrow("native custody lost");
    recipe.approvedPlan.kind = "report-only";
    expect(() => assertRecipeUpdateBinding(recipe, "/selected-install", "original")).toThrow();
  });
});
