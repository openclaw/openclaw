// Runtime handlers for local Claws CLI commands.
import { resolve } from "node:path";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { readClawFeedFile, readClawManifestFromFeed } from "../claws/feed.js";
import { buildClawApplyPlan } from "../claws/lifecycle.js";
import { buildClawPlan } from "../claws/plan.js";
import { readClawManifestFile } from "../claws/reader.js";
import type { ClawApplyPlan } from "../claws/types.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type {
  ClawsApplyOptions,
  ClawsFeedApplyOptions,
  ClawsFeedInspectOptions,
  ClawsInspectOptions,
} from "./claws-cli.js";

type DiagnosticLike = { level: string; code: string; path: string; message: string };

function formatDiagnostics(diagnostics: DiagnosticLike[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

function logClawApplyPlanSummary(plan: ClawApplyPlan, runtime: RuntimeEnv): void {
  runtime.log("Dry-run: true");
  runtime.log("Mutation allowed: false");
  runtime.log(`Entries: ${plan.summary.totalEntries}`);
  runtime.log(`Install actions: ${plan.summary.installActions}`);
  runtime.log(`Consent required: ${plan.summary.consentRequired}`);
  runtime.log(`Provenance records: ${plan.summary.provenanceRecords}`);
  runtime.log(`Rollback actions: ${plan.summary.rollbackActions}`);
  if (plan.summary.blockedEntries > 0) {
    runtime.log(`Blocked entries: ${plan.summary.blockedEntries}`);
  }
}

function failNonDryRun(opts: { dryRun?: boolean; json?: boolean }, runtime: RuntimeEnv): boolean {
  if (opts.dryRun) {
    return false;
  }
  const message =
    "Claw apply is dry-run only in this OpenClaw build; pass --dry-run to preview lifecycle actions.";
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, error: { code: "dry_run_required", message } });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
  return true;
}

export async function runClawsInspectCommand(
  manifestPath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const result = await readClawManifestFile(manifestPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const payload = {
    valid: true,
    sourcePath: resolve(manifestPath),
    manifest: result.manifest,
    diagnostics: result.diagnostics,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Claw: ${result.manifest.name} (${result.manifest.id}@${result.manifest.version})`);
  runtime.log(`Entries: ${result.manifest.entries.length}`);
  if (result.manifest.optionalUnknownEntries.length > 0) {
    runtime.log(`Optional unsupported entries: ${result.manifest.optionalUnknownEntries.length}`);
  }
  if (result.diagnostics.length > 0) {
    runtime.log(formatDiagnostics(result.diagnostics));
  }
}

export async function runClawsApplyCommand(
  manifestPath: string,
  opts: ClawsApplyOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (failNonDryRun(opts, runtime)) {
    return;
  }

  const result = await readClawManifestFile(manifestPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const plan = buildClawApplyPlan(
    buildClawPlan({
      manifest: result.manifest,
      diagnostics: result.diagnostics,
      sourcePath: resolve(manifestPath),
    }),
  );

  if (opts.json) {
    writeRuntimeJson(runtime, plan);
    return;
  }

  runtime.log(`Claw apply plan: ${plan.claw.name} (${plan.claw.id}@${plan.claw.version})`);
  logClawApplyPlanSummary(plan, runtime);
}

export async function runClawsFeedInspectCommand(
  feedPath: string,
  opts: ClawsFeedInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const result = await readClawFeedFile(feedPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const payload = {
    valid: true,
    sourcePath: resolve(feedPath),
    feed: result.feed,
    diagnostics: result.diagnostics,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Claw feed: ${result.feed.name} (${result.feed.id})`);
  runtime.log(`Entries: ${result.feed.entries.length}`);
  if (result.diagnostics.length > 0) {
    runtime.log(formatDiagnostics(result.diagnostics));
  }
}

export async function runClawsFeedApplyCommand(
  feedPath: string,
  clawId: string,
  opts: ClawsFeedApplyOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (failNonDryRun(opts, runtime)) {
    return;
  }

  const result = await readClawManifestFromFeed({ feedPath, entryId: clawId });
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, diagnostics: result.diagnostics });
    } else {
      runtime.error(formatDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const plan = buildClawApplyPlan(
    buildClawPlan({
      manifest: result.manifest,
      diagnostics: result.diagnostics,
      sourcePath: result.manifestPath,
    }),
  );
  const payload = {
    ...plan,
    feed: {
      id: result.feed.id,
      name: result.feed.name,
      sourcePath: resolve(feedPath),
      entry: result.entry,
    },
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Claw apply plan: ${plan.claw.name} (${plan.claw.id}@${plan.claw.version})`);
  runtime.log(`Feed: ${result.feed.name} (${result.feed.id})`);
  logClawApplyPlanSummary(plan, runtime);
  if (result.diagnostics.length > 0) {
    runtime.log(formatDiagnostics(result.diagnostics));
  }
}
