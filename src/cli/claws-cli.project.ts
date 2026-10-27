import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import {
  CLAW_BUILD_RESULT_SCHEMA_VERSION,
  buildClawProject,
  extractBuiltClawArtifact,
} from "../claws/project-build.js";
import {
  CLAW_PROJECT_RESULT_SCHEMA_VERSION,
  ClawProjectError,
  createClawProject,
  validateClawProject,
} from "../claws/project.js";
import { readClawManifestFile } from "../claws/reader.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "../claws/types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawAgentConfiguration,
} from "./claws-cli-output.js";
import type {
  ClawsBuildOptions,
  ClawsCreateOptions,
  ClawsDevOptions,
  ClawsValidateOptions,
} from "./claws-cli.js";

const CLAW_DEV_RESULT_SCHEMA_VERSION = "openclaw.clawDev.v1" as const;

function reportProjectError(
  error: unknown,
  fallbackCode: string,
  schemaVersion:
    | typeof CLAW_PROJECT_RESULT_SCHEMA_VERSION
    | typeof CLAW_BUILD_RESULT_SCHEMA_VERSION
    | typeof CLAW_DEV_RESULT_SCHEMA_VERSION,
  json: boolean | undefined,
): void {
  const code = error instanceof ClawProjectError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  emitClawFailure(json, message, {
    schemaVersion,
    stability: CLAW_OUTPUT_STABILITY,
    ok: false,
    error: { code, message },
  });
}

export async function runClawsCreateCommand(
  projectPath: string,
  opts: ClawsCreateOptions,
): Promise<void> {
  try {
    const result = await createClawProject(projectPath, {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        ok: true,
        ...result,
      });
      return;
    }
    runtime.log(`Created Claw project: ${result.root}`);
    runtime.log(`Package: ${result.packageJson.name}@${result.packageJson.version}`);
  } catch (error) {
    reportProjectError(
      error,
      "project_create_failed",
      CLAW_PROJECT_RESULT_SCHEMA_VERSION,
      opts.json,
    );
  }
}

export async function runClawsValidateCommand(
  projectPath: string,
  opts: ClawsValidateOptions,
): Promise<void> {
  const result = await validateClawProject(projectPath);
  if (!result.ok) {
    emitClawFailure(opts.json, formatClawDiagnostics(result.diagnostics), {
      schemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      root: result.root,
      diagnostics: result.diagnostics,
    });
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: true,
      root: result.root,
      source: result.claw.source,
      manifest: result.claw.manifest,
      ...(result.claw.openClawProfile ? { openClawProfile: result.claw.openClawProfile } : {}),
      excludedPaths: result.excludedPaths,
      diagnostics: result.diagnostics,
    });
    return;
  }
  runtime.log(`Valid Claw project: ${result.root}`);
  runtime.log(`Package: ${result.packageJson.name}@${result.packageJson.version}`);
  for (const path of result.excludedPaths) {
    runtime.log(`Excluded: ${path}`);
  }
}

export async function runClawsBuildCommand(
  projectPath: string,
  opts: ClawsBuildOptions,
): Promise<void> {
  try {
    const result = await buildClawProject(projectPath, opts.out);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, stability: CLAW_OUTPUT_STABILITY, ok: true });
      return;
    }
    runtime.log(`Built Claw: ${result.claw.name}@${result.claw.version}`);
    runtime.log(`Artifact: ${result.artifact}`);
    runtime.log(`Integrity: ${result.integrity}`);
    runtime.log(`Excluded project paths: ${result.excludedPaths.length}`);
  } catch (error) {
    reportProjectError(error, "project_build_failed", CLAW_BUILD_RESULT_SCHEMA_VERSION, opts.json);
  }
}

export async function runClawsDevCommand(
  projectPath: string,
  opts: ClawsDevOptions,
): Promise<void> {
  let build: Awaited<ReturnType<typeof buildClawProject>>;
  let plan: ClawAddPlan;
  try {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-claw-dev-",
    });
    build = await buildClawProject(projectPath, workspace.path("claw.tgz"));
    await using extracted = await extractBuiltClawArtifact(build.artifact);
    const result = await readClawManifestFile(extracted.packageRoot);
    if (!result.ok) {
      throw new ClawProjectError(
        "artifact_verification_failed",
        formatClawDiagnostics(result.diagnostics),
      );
    }
    const configSnapshot = await readConfigFileSnapshot({
      observe: false,
      skipPluginValidation: true,
    });
    if (!configSnapshot.valid) {
      throw new ClawProjectError(
        "config_unavailable",
        "OpenClaw config is invalid; fix it before previewing a Claw project.",
      );
    }
    const config = configSnapshot.resolved;
    const existingMcpServers = config.mcp?.servers ?? {};
    const existingAgentIds = listAgentIds(config);
    plan = await buildClawAddPlan({
      manifest: result.manifest,
      clawMarkdownBody: result.clawMarkdownBody,
      packageBootstrap: result.packageBootstrap,
      openClawProfile: result.openClawProfile,
      source: {
        ...result.source,
        integrityKind: "artifact",
        integrity: build.integrity,
        byteLength: build.byteLength,
      },
      diagnostics: result.diagnostics,
      context: {
        config,
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
        ...(opts.workspace ? { workspace: opts.workspace } : {}),
        existingAgentIds,
        existingWorkspacePaths: existingAgentIds.map((agentId) =>
          resolveAgentWorkspaceDir(config, agentId),
        ),
        existingMcpServers,
        sourceReferenceRoot: `claw-artifact:${build.integrity}`,
      },
    });
  } catch (error) {
    reportProjectError(error, "project_dev_failed", CLAW_DEV_RESULT_SCHEMA_VERSION, opts.json);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_DEV_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      offline: true,
      mutationAllowed: false,
      build: {
        integrity: build.integrity,
        byteLength: build.byteLength,
        files: build.files,
        excludedPaths: build.excludedPaths,
        claw: build.claw,
      },
      plan,
    });
  } else {
    runtime.log(`Claw dev preview: ${build.claw.name}@${build.claw.version}`);
    runtime.log(`Artifact integrity: ${build.integrity}`);
    runtime.log(`Agent: ${plan.agent.finalId}`);
    runtime.log(`Workspace: ${plan.agent.workspace}`);
    logClawAgentConfiguration(plan);
    runtime.log(`Actions: ${plan.summary.totalActions}`);
    runtime.log(`Capability escalations: ${plan.capabilityChanges.length}`);
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
    if (plan.blockers.length > 0) {
      runtime.error(formatClawDiagnostics(plan.blockers));
    }
  }
  if (plan.blockers.length > 0) {
    runtime.exit(1);
  }
}
