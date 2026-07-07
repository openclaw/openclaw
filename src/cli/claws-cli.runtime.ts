// Runtime handlers for local Claws CLI commands.
import { resolve } from "node:path";
import { buildClawPlan } from "../claws/plan.js";
import { readClawManifestFile } from "../claws/reader.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawsInspectOptions, ClawsPlanOptions } from "./claws-cli.js";

type DiagnosticLike = { level: string; code: string; path: string; message: string };

function formatDiagnostics(diagnostics: DiagnosticLike[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

export async function runClawsInspectCommand(
  manifestPath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
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

export async function runClawsPlanCommand(
  manifestPath: string,
  opts: ClawsPlanOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
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

  const plan = buildClawPlan({
    manifest: result.manifest,
    diagnostics: result.diagnostics,
    sourcePath: resolve(manifestPath),
  });

  if (opts.json) {
    writeRuntimeJson(runtime, plan);
    return;
  }

  runtime.log(`Claw plan: ${plan.claw.name} (${plan.claw.id}@${plan.claw.version})`);
  runtime.log("Read-only: true");
  runtime.log(`Entries: ${plan.summary.totalEntries}`);
  runtime.log(`Requires consent later: ${plan.summary.requiresConsent}`);
  if (plan.summary.unsupportedOptionalEntries > 0) {
    runtime.log(`Unsupported optional entries: ${plan.summary.unsupportedOptionalEntries}`);
  }
}
