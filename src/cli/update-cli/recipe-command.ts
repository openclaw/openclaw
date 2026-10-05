import fs from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { authenticateUpgradeRecipeCatalog } from "../../infra/upgrade-recipes/catalog.js";
import { verifyAuthenticatedUpgradeInstallation } from "../../infra/upgrade-recipes/installation-identity.js";
import { inspectUpgradeRecipeInstallation } from "../../infra/upgrade-recipes/inventory.js";
import { readUpgradeRecipeMaintenanceReceipt } from "../../infra/upgrade-recipes/maintenance.js";
import { createUpgradeRecipePlan } from "../../infra/upgrade-recipes/planner.js";
import { updateRecipePlanCommand } from "./plan.js";

/** Independent entry point: never import the installation's CLI or run its startup hooks. */
export async function runUpgradeRecipeCommand(argv: readonly string[]): Promise<void> {
  const program = new Command().name("openclaw-updater").exitOverride();
  program
    .command("plan")
    .requiredOption("--installation <path>", "Canonical installation selected by its owner")
    .option("--target <release-id>", "Exact target release identity")
    .option("--catalog <path>", "Unauthenticated local preview only")
    .option(
      "--verify",
      "Refresh provisioned trust metadata and verify installed file closure",
      false,
    )
    .option("--control-root <path>", "Private provisioned update control directory")
    .option("--metadata-url <url>", "Authenticated metadata transport")
    .option("--targets-url <url>", "Authenticated target transport")
    .option("--catalog-target <name>", "Exact signed top-level catalog target")
    .option("--source <release-id>", "Exact source identity to verify, never inferred from version")
    .option("--artifacts-dir <path>", "Private retained authenticated artifact directory")
    .option(
      "--workspace <path>",
      "Participating workspace boundary",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--executable",
      "Prepare an exact private executable plan using native staging and rehearsal",
      false,
    )
    .option("--output <path>", "New owner-private executable plan artifact in retained artifacts")
    .option("--state-root <path>", "Exact canonical participating live state root")
    .option("--config <path>", "Exact canonical authored configuration file")
    .option("--profile <name>", "Exact selected managed Gateway profile", "default")
    .option("--port <number>", "Exact managed Gateway listener port", Number)
    .option("--runner-root <path>", "Canonical independent authenticated runner bundle")
    .option("--runner-manifest <artifact-id>", "Exact signed runner manifest identity")
    .option("--archive <path>", "Privately retained exact authenticated local package archive")
    .option("--qualification <id>", "Exact signed historical route qualification")
    .option("--timeout-ms <number>", "Bound for private staging and rehearsal", Number, 600_000)
    .option("--json", "Output the plan as JSON", false)
    .action(
      async (options: {
        installation: string;
        target?: string;
        catalog?: string;
        verify: boolean;
        controlRoot?: string;
        metadataUrl?: string;
        targetsUrl?: string;
        catalogTarget?: string;
        source?: string;
        artifactsDir?: string;
        workspace: string[];
        executable: boolean;
        output?: string;
        stateRoot?: string;
        config?: string;
        profile: string;
        port?: number;
        runnerRoot?: string;
        runnerManifest?: string;
        archive?: string;
        qualification?: string;
        timeoutMs: number;
        json: boolean;
      }) => {
        if (!options.verify) {
          if (
            options.controlRoot ||
            options.metadataUrl ||
            options.targetsUrl ||
            options.catalogTarget ||
            options.source ||
            options.artifactsDir ||
            options.executable ||
            options.output ||
            options.stateRoot ||
            options.config ||
            options.port !== undefined ||
            options.runnerRoot ||
            options.runnerManifest ||
            options.archive ||
            options.qualification
          ) {
            throw new Error(
              "Trust/source verification options require --verify; passive preview never contacts the network.",
            );
          }
          await updateRecipePlanCommand(options);
          return;
        }
        if (
          options.catalog ||
          !options.controlRoot ||
          !options.metadataUrl ||
          !options.targetsUrl ||
          !options.catalogTarget ||
          !options.source ||
          !options.artifactsDir ||
          options.workspace.length === 0
        ) {
          throw new Error(
            "Verified planning requires provisioned control/trust URLs, exact source, retained artifacts, and every participating workspace; --catalog cannot confer trust.",
          );
        }
        if (
          !options.executable &&
          (options.output ||
            options.stateRoot ||
            options.config ||
            options.port !== undefined ||
            options.runnerRoot ||
            options.runnerManifest ||
            options.archive ||
            options.qualification)
        ) {
          throw new Error(
            "Executable planning selectors require --verify --executable; report-only plans do not stage candidates.",
          );
        }
        const root = path.resolve(options.installation);
        const forbiddenRoots = [
          root,
          ...options.workspace.map((workspace) => path.resolve(workspace)),
          ...(options.executable && options.stateRoot ? [path.resolve(options.stateRoot)] : []),
        ];
        // Refuse nonexistent boundaries rather than resolving selectors differently later.
        for (const boundary of forbiddenRoots) {
          if ((await fs.realpath(boundary)) !== boundary) {
            throw new Error("Verified planning requires canonical installation/workspace paths.");
          }
        }
        const controlRoot = path.resolve(options.controlRoot);
        if (options.executable) {
          if (
            !options.target ||
            !options.output ||
            !options.stateRoot ||
            !options.config ||
            options.port === undefined ||
            !options.runnerRoot ||
            !options.runnerManifest ||
            !options.archive ||
            !options.qualification
          ) {
            throw new Error(
              "Executable planning requires exact target/output/state/config/port/runner/archive/qualification selectors; no missing fact is inferred.",
            );
          }
          const { prepareExecutableRecipePlan, writeExecutableRecipePlan } =
            await import("./recipe-plan.js");
          const recipe = await prepareExecutableRecipePlan({
            installationRoot: root,
            stateRoot: path.resolve(options.stateRoot),
            configPath: path.resolve(options.config),
            profile: options.profile,
            port: options.port,
            catalog: {
              controlRoot,
              metadataDir: path.join(controlRoot, "metadata"),
              metadataBaseUrl: options.metadataUrl,
              targetBaseUrl: options.targetsUrl,
              targetPath: options.catalogTarget,
              forbiddenRoots,
            },
            sourceReleaseId: options.source,
            targetReleaseId: options.target,
            qualificationId: options.qualification,
            runnerRoot: path.resolve(options.runnerRoot),
            runnerManifestArtifactId: options.runnerManifest,
            runnerEntryUrl: import.meta.url,
            artifactsDirectory: path.resolve(options.artifactsDir),
            localArchivePath: path.resolve(options.archive),
            timeoutMs: options.timeoutMs,
          });
          await writeExecutableRecipePlan(options.output, recipe);
          process.stdout.write(
            `${JSON.stringify({
              kind: "executable",
              mutationEnabled: true,
              output: path.resolve(options.output),
              digest: recipe.approvedPlanDigest,
              runId: recipe.maintenance.binding.runId,
              preparation: "private-stage-and-rehearsal-only",
            })}\n`,
          );
          return;
        }
        const catalog = await authenticateUpgradeRecipeCatalog({
          controlRoot,
          metadataDir: path.join(controlRoot, "metadata"),
          metadataBaseUrl: options.metadataUrl,
          targetBaseUrl: options.targetsUrl,
          targetPath: options.catalogTarget,
          forbiddenRoots,
        });
        const identity = await verifyAuthenticatedUpgradeInstallation({
          catalog,
          root,
          releaseId: options.source,
          artifactsDirectory: options.artifactsDir,
          forbiddenRoots,
        });
        const inventory = await inspectUpgradeRecipeInstallation(root);
        inventory.identityClass = "verified-release";
        inventory.releaseId = identity.releaseId;
        const plan = createUpgradeRecipePlan({
          inventory,
          targetReleaseId: options.target,
          catalog: catalog.catalog,
        });
        // File identity/authentication is evidence only. Existing execution owners
        // must still bind service, state, recovery and approval before mutation.
        process.stdout.write(
          `${JSON.stringify({ ...plan, authenticatedCatalog: catalog.admission, sourceIdentity: identity })}\n`,
        );
        process.exitCode = plan.outcome === "blocked" ? 1 : 0;
      },
    );
  program
    .command("apply")
    .requiredOption(
      "--installation <path>",
      "Canonical installation selected by the native bootstrap",
    )
    .requiredOption("--plan <path>", "Private exact executable plan and retained recipe context")
    .requiredOption("--approve <sha256>", "Explicit consent to the displayed complete plan digest")
    .action(async (options: { installation: string; plan: string; approve: string }) => {
      const { applyApprovedRecipeUpdate } = await import("./recipe-apply.js");
      await applyApprovedRecipeUpdate({
        installation: options.installation,
        planPath: options.plan,
        approvedDigest: options.approve,
        runnerEntryUrl: import.meta.url,
      });
    });
  program
    .command("resume")
    .requiredOption("--installation <path>", "Exact original canonical installation selection")
    .requiredOption("--state-database <path>", "Exact original operational ledger")
    .requiredOption("--run <id>", "Original retained recipe run; never creates a new update")
    .action(async (options: { installation: string; stateDatabase: string; run: string }) => {
      const { resumeRetainedRecipeUpdate } = await import("./recipe-resume.js");
      const result = await resumeRetainedRecipeUpdate({
        installation: options.installation,
        ledgerPath: options.stateDatabase,
        runId: options.run,
        runnerEntryUrl: import.meta.url,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
  program
    .command("status")
    .requiredOption("--installation <path>", "Canonical installation bound by the native caller")
    .requiredOption("--state-database <path>", "Owner-selected canonical shared state database")
    .option("--run <id>", "Require the exact original upgrade run")
    .action(async (options: { installation: string; stateDatabase: string; run?: string }) => {
      const installation = path.resolve(options.installation);
      if ((await fs.realpath(installation)) !== installation) {
        throw new Error(
          "Upgrade status requires the canonical installation selected by its owner.",
        );
      }
      const pathname = path.resolve(options.stateDatabase);
      if ((await fs.realpath(pathname)) !== pathname) {
        throw new Error("Upgrade status requires the canonical original-owner database path.");
      }
      const receipt = await readUpgradeRecipeMaintenanceReceipt({ path: pathname });
      if (receipt && receipt.binding.installationKey !== installation) {
        throw new Error("The maintenance receipt belongs to another installation.");
      }
      if (options.run && receipt && receipt.binding.runId !== options.run) {
        throw new Error(
          "The selected database does not identify the requested original upgrade owner.",
        );
      }
      let original: { runId: string; status: string; phase: string } | undefined;
      if (options.run) {
        const { createRetainedUpgradeRecipeRunStore } =
          await import("../../infra/upgrade-recipes/retained-run.js");
        const { captureOpenClawStateWorkerContext } =
          await import("../../state/openclaw-state-worker-context.js");
        const context = captureOpenClawStateWorkerContext({ path: pathname });
        const retained = await createRetainedUpgradeRecipeRunStore({
          path: pathname,
          context,
          assertCurrent: () => context.admission.assertCurrent(),
        }).read(options.run);
        if (!retained || retained.pointer.nativeAuthority.installKey !== installation) {
          throw new Error("The selected database does not retain this original installation/run.");
        }
        original = { runId: retained.runId, status: retained.status, phase: retained.phase };
      }
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          mutationEnabled: false,
          maintenance: receipt,
          ...(original ? { original } : {}),
        })}\n`,
      );
    });
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}
