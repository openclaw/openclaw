import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { planLegacyConfigForUpdateChannel } from "../../commands/doctor/legacy-config-repair.js";
import { cloneEnvWithPlatformSemantics } from "../../config/env-vars.js";
import { createConfigIO } from "../../config/io.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { resolveStateDir } from "../../config/paths.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { tryReadJson } from "../../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  parseUpdateAdmissionContext,
  type UpdateAdmissionContext,
} from "../../infra/update-admission-contract.js";
import {
  UPDATE_ADMISSION_PROTOCOL,
  type UpdateAdmissionVerdict,
} from "../../infra/update-run-schema.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../../plugins/installed-plugin-index-record-reader.js";
import { defaultRuntime } from "../../runtime.js";
import { parsePackageOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { resolveUpdateRoot, UpdatePreMutationError } from "./shared.js";
import { preflightConfiguredNpmPluginTargets } from "./update-command-plugin-preflight.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** Inspect live inputs using this candidate's contracts, without admitting a mutable run. */
async function inspectUpdateAdmission(
  context: UpdateAdmissionContext,
): Promise<UpdateAdmissionVerdict> {
  return await withArtifactPreservingStateReads(async () => {
    if (
      !path.isAbsolute(context.installation.root) ||
      context.installation.installKind !== "package"
    ) {
      throw new Error("Candidate admission requires an explicit package installation root.");
    }
    const root = await resolveUpdateRoot({ root: context.installation.root });
    const candidateRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    if (!candidateRoot) {
      throw new Error("Candidate package root is unavailable.");
    }
    const manifest = await tryReadJson<unknown>(path.join(candidateRoot, "package.json"), {
      maxBytes: 1024 * 1024,
    });
    if (!isRecord(manifest) || typeof manifest.version !== "string" || !manifest.version.trim()) {
      throw new Error("Candidate package version is unavailable.");
    }
    const candidateVersion = manifest.version;
    const schemaVersions = parsePackageOpenClawSchemaVersions(manifest);
    if (!schemaVersions) {
      throw new Error("Candidate package schema declarations are unavailable.");
    }
    const installedVersion = await readPackageVersion(root, { maxBytes: 1024 * 1024 });
    const env = cloneEnvWithPlatformSemantics(process.env);
    env.OPENCLAW_VERSION = candidateVersion;
    env.OPENCLAW_DEV_SOURCE_ROOT = candidateRoot;
    delete env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    return await withOwnedManagedUpdateEnv(env, async () => {
      const timeoutMs = context.request.timeoutMs ?? 120_000;
      const checks: UpdateAdmissionVerdict["facts"]["checks"] = [];
      const reasons: UpdateAdmissionVerdict["reasons"] = [];
      const warnings: UpdateAdmissionVerdict["warnings"] = [];
      const refuse = (name: string, code: string, message: string, nextAction?: string) => {
        checks.push({ name, status: "refuse", detail: message });
        reasons.push({ code, message, ...(nextAction ? { nextAction } : {}) });
      };
      let databaseContext:
        | Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>>
        | undefined;
      try {
        // Doctor's existing planner supplies a source-bound projection; it never applies it here.
        const { snapshot, writeOptions } = await createConfigIO({
          env: cloneEnvWithPlatformSemantics(env),
          pluginValidation: "core-only",
          observe: false,
          shellEnvFallback: "defer",
          suppressFutureVersionWarning: true,
        }).readConfigFileSnapshotForWrite();
        const legacyConfigPlan =
          !snapshot.valid && snapshot.legacyIssues.length
            ? planLegacyConfigForUpdateChannel(snapshot, writeOptions)
            : undefined;
        databaseContext = await captureTargetDatabaseSchemaContext(env, { legacyConfigPlan });
        if (legacyConfigPlan) {
          warnings.push({
            code: "config-warning",
            message:
              "Configuration contains legacy fields that candidate Doctor can repair after installation.",
          });
        }
        checks.push({ name: "config", status: warnings.length ? "warn" : "ok" });
      } catch (error) {
        if (!(error instanceof UpdatePreMutationError)) {
          throw error;
        }
        refuse(
          "config",
          error.reason,
          error.message,
          "Run openclaw doctor --fix, then correct any remaining configuration errors and retry.",
        );
        databaseContext = undefined;
      }
      let schemasAccepted = false;
      let pluginInstallRecords: Record<string, PluginInstallRecord> | undefined;
      if (databaseContext) {
        try {
          const schemas = await checkTargetDatabaseSchemasForContexts(schemaVersions, [
            databaseContext,
          ]);
          if (hasSchemaRefusal(schemas)) {
            refuse(
              "database-schema",
              "database-schema-preflight",
              formatSchemaRefusalLines(schemas).join("\n"),
            );
          } else {
            checks.push({ name: "database-schema", status: "ok" });
            schemasAccepted = true;
          }
        } catch (error) {
          if (!(error instanceof UpdatePreMutationError)) {
            throw error;
          }
          refuse("database-schema", error.reason, error.message);
        }
      }
      // Plugin metadata reads require compatible stores; never let them mask a schema refusal.
      if (databaseContext && schemasAccepted && !databaseContext.legacyConfigPlan) {
        const { snapshot, pluginMetadataSnapshot } = await createConfigIO({
          env: cloneEnvWithPlatformSemantics(env),
          observe: false,
          suppressFutureVersionWarning: true,
          shellEnvFallback: "defer",
        }).readConfigFileSnapshotWithPluginMetadata();
        if (!snapshot.valid || snapshot.readError) {
          const message = [
            "Update refused: configuration is invalid or unreadable.",
            ...formatConfigIssueLines(
              snapshot.issues.map(({ path: issuePath, pathSegments }) => ({
                path: issuePath,
                pathSegments,
                message: "Invalid configuration field",
              })),
              "-",
              { normalizeRoot: true },
            ),
          ].join("\n");
          checks[0] = { name: "config", status: "refuse", detail: message };
          reasons.push({
            code: "invalid-config",
            message,
            nextAction:
              "Run openclaw doctor --fix, then correct any remaining configuration errors and retry.",
          });
          databaseContext = undefined;
        } else {
          pluginInstallRecords = pluginMetadataSnapshot?.index.installRecords;
          warnings.push(
            ...snapshot.warnings.map((warning) => ({
              code: warning.code ?? "config-warning",
              message: `${warning.path}: ${warning.message}`,
            })),
          );
          if (snapshot.warnings.length) {
            checks[0] = { name: "config", status: "warn" };
          }
        }
      }
      const nodeEngines =
        isRecord(manifest.engines) && typeof manifest.engines.node === "string"
          ? manifest.engines.node
          : undefined;
      const runtimeCompatible =
        !nodeEngines || nodeVersionSatisfiesEngine(process.versions.node, nodeEngines) === true;
      // Selection and provisioning require the installed supervisor's execution authority.
      checks.push({
        name: "node-runtime",
        status: runtimeCompatible ? "ok" : "warn",
        ...(!runtimeCompatible
          ? {
              detail: `Candidate requires Node ${nodeEngines}; selected runtime is Node ${process.versions.node}. The installed updater selects or provisions a compatible runtime.`,
            }
          : {}),
      });
      if (databaseContext && schemasAccepted) {
        const pluginWarnings = await preflightConfiguredNpmPluginTargets({
          config: databaseContext.config,
          env: databaseContext.env,
          targetVersion: candidateVersion,
          channel: context.target.channel,
          timeoutMs,
          installRecords:
            pluginInstallRecords ??
            loadInstalledPluginIndexInstallRecordsSync({
              env: databaseContext.env,
              artifactPreservingReadOnly: true,
            }),
        });
        warnings.push(
          ...pluginWarnings.map((warning) => ({
            code: "plugin-availability",
            message: warning.message,
          })),
        );
        checks.push({ name: "plugin-availability", status: pluginWarnings.length ? "warn" : "ok" });
      }
      return {
        protocol: UPDATE_ADMISSION_PROTOCOL,
        verdict: reasons.length ? "refuse" : "admit",
        reasons,
        warnings,
        facts: { candidateVersion, installedVersion, nodeEngines, checks },
      };
    });
  });
}

/** Internal protocol receiver; failures return no verdict and cannot inherit update authority. */
export async function updateAdmitCommand(contextPath?: string): Promise<void> {
  try {
    if (Object.keys(process.env).some(isUpdateAdmissionAuthorityEnvKey)) {
      throw new Error("Candidate admission requires an authority-free supervisor invocation.");
    }
    if (!contextPath || !path.isAbsolute(contextPath)) {
      throw new Error("Candidate admission context path is missing or invalid.");
    }
    const stat = await fs.stat(contextPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error("Candidate admission context is not a bounded regular file.");
    }
    const context = parseUpdateAdmissionContext(JSON.parse(await fs.readFile(contextPath, "utf8")));
    if (!context) {
      throw new Error("Candidate admission context is invalid.");
    }
    const verdict = await inspectUpdateAdmission(context);
    defaultRuntime.writeJson(verdict);
    process.exitCode = verdict.verdict === "admit" ? 0 : 3;
  } catch (error) {
    defaultRuntime.error(
      redactSupportDiagnosticLine(error instanceof Error ? error.message : String(error), {
        env: process.env,
        stateDir: resolveStateDir(process.env),
      }),
    );
    process.exitCode = 2;
  }
}
