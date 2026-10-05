import "../../infra/sealed-runtime-bootstrap.js";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { registerUpgradeRecipeRunnerProcesses } from "../../infra/upgrade-recipes/runner-processes.js";
import { observeReleaseQualificationBinding } from "./recipe-first-qualification.js";

registerUpgradeRecipeRunnerProcesses(new URL("./", import.meta.url));
const identity = z.string().min(1);
const inputSchema = z.strictObject({
  installationRoot: identity,
  stateRoot: identity,
  configPath: identity,
  profile: identity,
  port: z.number().int().min(1).max(65535),
  sourceReleaseId: identity,
  targetReleaseId: identity,
  runnerRoot: identity,
  runnerManifestArtifactId: identity,
  artifactsDirectory: identity,
  localArchivePath: identity,
  timeoutMs: z.number().int().positive(),
  recipe: z.strictObject({ id: identity, revision: z.number().int().positive() }),
  catalog: z.strictObject({
    controlRoot: identity,
    metadataDir: identity,
    metadataBaseUrl: identity,
    targetBaseUrl: identity,
    targetPath: identity,
    forbiddenRoots: z.array(identity).min(1),
  }),
});
try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      input: { type: "string" },
      plan: { type: "string" },
      resume: { type: "boolean" },
      status: { type: "boolean" },
      installation: { type: "string" },
      ledger: { type: "string" },
      "run-id": { type: "string" },
    },
  });
  if (values.resume && values.status) {
    throw new Error("Release recovery must select one original-run operation.");
  }
  if (values.status) {
    if (
      !values.installation ||
      !values.ledger ||
      !values["run-id"] ||
      values.input ||
      values.plan
    ) {
      throw new Error("Release status requires only the original installation, ledger and run ID.");
    }
    const { runUpgradeRecipeCommand } = await import("./recipe-command.js");
    await runUpgradeRecipeCommand([
      "status",
      "--installation",
      values.installation,
      "--state-database",
      values.ledger,
      "--run",
      values["run-id"],
    ]);
  } else if (values.resume) {
    if (
      !values.installation ||
      !values.ledger ||
      !values["run-id"] ||
      values.input ||
      values.plan
    ) {
      throw new Error("Release resume requires the original installation, ledger and run ID.");
    }
    const { resumeRetainedRecipeUpdate } = await import("./recipe-resume.js");
    await resumeRetainedRecipeUpdate({
      installation: values.installation,
      ledgerPath: values.ledger,
      runId: values["run-id"],
      runnerEntryUrl: import.meta.url,
    });
  } else {
    if (!values.input || !values.plan || values.ledger || values["run-id"]) {
      throw new Error("First qualification requires exact input and new retained plan paths.");
    }
    const { recipe, ...options } = inputSchema.parse(
      JSON.parse(await fs.readFile(values.input, "utf8")),
    );
    if (!values.installation || values.installation !== options.installationRoot) {
      throw new Error("First qualification must retain the native installation selection.");
    }
    const { prepareExecutableRecipePlan, writeExecutableRecipePlan } =
      await import("./recipe-plan.js");
    const prepared = await prepareExecutableRecipePlan({
      ...options,
      runnerEntryUrl: import.meta.url,
      releaseQualification: await observeReleaseQualificationBinding(recipe),
    });
    await writeExecutableRecipePlan(values.plan, prepared);
    const { applyApprovedRecipeUpdate } = await import("./recipe-apply.js");
    await applyApprovedRecipeUpdate({
      installation: options.installationRoot,
      planPath: values.plan,
      approvedDigest: prepared.approvedPlanDigest,
      runnerEntryUrl: import.meta.url,
    });
  }
} catch (error) {
  process.stderr.write(
    `Release qualification failed: ${error instanceof Error ? error.message : "unknown failure"}. No production qualification was recorded.\n`,
  );
  process.exitCode = 1;
}
