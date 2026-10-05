import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateRunResult } from "../../infra/update-run-result.js";
import { authenticateUpgradeRecipeCatalog } from "../../infra/upgrade-recipes/catalog.js";
import { assertUpgradeRecipeCapacityInputs } from "../../infra/upgrade-recipes/execution-capacity.js";
import { verifyRecipeQualificationEvidence } from "./recipe-qualification.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  assertRecipeUpdateBinding,
  recipeUpdateContextSchema,
  verifyRecipeUpdateArchive,
  verifyRecipeUpdateRunner,
  type RecipeUpdateContext,
} from "./update-recipe-context.js";

const MAX_APPROVED_PLAN_BYTES = 1024 * 1024;

/** Explicit digest consent is an invocation fact, not a lease or a reusable approval token. */
async function readApprovedRecipeUpdateContext(
  filename: string,
  approvedDigest: string,
): Promise<RecipeUpdateContext> {
  if (!/^[a-f0-9]{64}$/u.test(approvedDigest)) {
    throw new Error("Recipe apply requires the exact displayed plan digest.");
  }
  const pathname = path.resolve(filename);
  if ((await fs.realpath(pathname)) !== pathname) {
    throw new Error("Approved recipe plans require canonical owner-selected paths.");
  }
  const handle = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      (before.mode & 0o077) !== 0 ||
      (process.getuid && before.uid !== process.getuid()) ||
      before.size > MAX_APPROVED_PLAN_BYTES
    ) {
      throw new Error("Approved recipe plans require bounded private installation-owner files.");
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > MAX_APPROVED_PLAN_BYTES) {
        throw new Error("Approved recipe plan exceeds its byte limit.");
      }
      chunks.push(chunk);
    }
    const after = await handle.stat();
    const named = await fs.lstat(pathname);
    if (
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.isSymbolicLink()
    ) {
      throw new Error("Approved recipe plan changed while reading.");
    }
    const recipe = recipeUpdateContextSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (recipe.approvedPlanDigest !== approvedDigest) {
      throw new Error("Explicit approval does not match the selected recipe plan.");
    }
    assertRecipeUpdateBinding(
      recipe,
      recipe.maintenance.expected.installationRoot,
      recipe.maintenance.binding.runId,
    );
    return recipe;
  } finally {
    await handle.close();
  }
}

/** Thin caller of the existing updater, never a second package/migration/service engine. */
export async function applyApprovedRecipeUpdate(options: {
  installation: string;
  planPath: string;
  approvedDigest: string;
  runnerEntryUrl: string;
}): Promise<void> {
  const recipe = await readApprovedRecipeUpdateContext(options.planPath, options.approvedDigest);
  if (
    path.resolve(options.installation) !== recipe.maintenance.expected.installationRoot ||
    (await fs.realpath(options.installation)) !== recipe.maintenance.expected.installationRoot
  ) {
    throw new Error(
      "Recipe plan differs from the canonical installation selected by its native bootstrap.",
    );
  }
  // A command flag cannot make an installed or host runtime an authenticated retained runner.
  const catalog = await authenticateUpgradeRecipeCatalog(recipe.catalog);
  if (catalog.digest !== recipe.catalogDigest) {
    throw new Error("Authenticated recipe catalog changed; regenerate and approve the plan.");
  }
  const runner = await verifyRecipeUpdateRunner(recipe, catalog);
  if (
    (await fs.realpath(process.execPath)) !== runner.runtimePath ||
    (await fs.realpath(fileURLToPath(options.runnerEntryUrl))) !==
      (recipe.releaseQualification
        ? runner.releaseQualificationEntrypointPath
        : runner.entrypointPath)
  ) {
    throw new Error(
      "Recipe apply must execute from its exact authenticated retained runner and private runtime.",
    );
  }
  await verifyRecipeUpdateArchive(recipe);
  await assertUpgradeRecipeCapacityInputs(recipe.planningEvidence.executionCapacity, {
    installationRoot: recipe.maintenance.expected.installationRoot,
    runnerRoot: recipe.runner.root,
    archivePath: recipe.localArchivePath,
    stateRoot: recipe.maintenance.expected.stateRoot,
  });
  await verifyRecipeQualificationEvidence(recipe, catalog);
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "OPENSSL_CONF",
  ]) {
    if (process.env[key]?.trim()) {
      throw new Error("Recipe apply refuses runtime loader environment injection.");
    }
  }
  for (const key of [
    "OPENCLAW_UPDATE_RUN_ID",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_UPDATE_POST_CORE",
  ]) {
    if (process.env[key]?.trim()) {
      throw new Error("Fresh recipe apply cannot inherit an existing updater continuation.");
    }
  }
  const expected = recipe.maintenance.expected;
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: expected.stateRoot,
    OPENCLAW_CONFIG_PATH: expected.configPath,
    OPENCLAW_PROFILE: expected.profile,
  };
  let terminal: UpdateRunResult | undefined;
  await withOwnedManagedUpdateEnv(env, async () => {
    const { updateCommand } = await import("./update-command.js");
    await updateCommand({
      recipe,
      restart: true,
      yes: true,
      json: true,
      acceptCapabilities: false,
      onResult: (result) => {
        terminal = result;
      },
    });
  });
  // Restricted target maintenance alone is not successful managed-service activation.
  if (
    !terminal ||
    terminal.status !== "ok" ||
    terminal.runId !== recipe.maintenance.binding.runId ||
    terminal.root !== expected.installationRoot ||
    terminal.verification?.serviceRunning !== true ||
    terminal.verification.versionMatch !== true ||
    terminal.verification.readyz !== true ||
    terminal.verification.settled !== true ||
    terminal.verification.runningVersion !== expected.version ||
    terminal.verification.runningBuildId !== expected.buildId
  ) {
    throw new Error(
      "Recipe update did not verify its actual managed service; retain the original recovery owner.",
    );
  }
}
