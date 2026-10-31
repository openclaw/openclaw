import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import { buildTemplateAddPlan } from "../templates/lifecycle.js";
import {
  TEMPLATE_BUILD_RESULT_SCHEMA_VERSION,
  buildTemplateProject,
  extractBuiltTemplateArtifact,
} from "../templates/project-build.js";
import {
  TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
  TemplateProjectError,
  createTemplateProject,
  validateTemplateProject,
} from "../templates/project.js";
import { readTemplateManifestFile } from "../templates/reader.js";
import { TEMPLATE_OUTPUT_STABILITY, type TemplateAddPlan } from "../templates/types.js";
import {
  emitTemplateFailure,
  formatTemplateDiagnostics,
  logTemplateAgentConfiguration,
} from "./templates-cli-output.js";
import type {
  TemplatesBuildOptions,
  TemplatesCreateOptions,
  TemplatesDevOptions,
  TemplatesValidateOptions,
} from "./templates-cli.js";

const TEMPLATE_DEV_RESULT_SCHEMA_VERSION = "openclaw.templateDev.v1" as const;

function reportProjectError(
  error: unknown,
  fallbackCode: string,
  schemaVersion:
    | typeof TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION
    | typeof TEMPLATE_BUILD_RESULT_SCHEMA_VERSION
    | typeof TEMPLATE_DEV_RESULT_SCHEMA_VERSION,
  json: boolean | undefined,
): void {
  const code = error instanceof TemplateProjectError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  emitTemplateFailure(json, message, {
    schemaVersion,
    stability: TEMPLATE_OUTPUT_STABILITY,
    ok: false,
    error: { code, message },
  });
}

export async function runTemplatesCreateCommand(
  projectPath: string,
  opts: TemplatesCreateOptions,
): Promise<void> {
  try {
    const result = await createTemplateProject(projectPath, {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
        stability: TEMPLATE_OUTPUT_STABILITY,
        ok: true,
        ...result,
      });
      return;
    }
    runtime.log(`Created Template project: ${sanitizeTerminalText(result.root)}`);
    runtime.log(
      `Package: ${sanitizeTerminalText(result.packageJson.name)}@${sanitizeTerminalText(result.packageJson.version)}`,
    );
  } catch (error) {
    reportProjectError(
      error,
      "project_create_failed",
      TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
      opts.json,
    );
  }
}

export async function runTemplatesValidateCommand(
  projectPath: string,
  opts: TemplatesValidateOptions,
): Promise<void> {
  const result = await validateTemplateProject(projectPath);
  if (!result.ok) {
    emitTemplateFailure(opts.json, formatTemplateDiagnostics(result.diagnostics), {
      schemaVersion: TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      ok: false,
      root: result.root,
      diagnostics: result.diagnostics,
    });
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      ok: true,
      root: result.root,
      source: result.template.source,
      manifest: result.template.manifest,
      ...(result.template.openClawProfile
        ? { openClawProfile: result.template.openClawProfile }
        : {}),
      excludedPaths: result.excludedPaths,
      diagnostics: result.diagnostics,
    });
    return;
  }
  runtime.log(`Valid Template project: ${sanitizeTerminalText(result.root)}`);
  runtime.log(
    `Package: ${sanitizeTerminalText(result.packageJson.name)}@${sanitizeTerminalText(result.packageJson.version)}`,
  );
  for (const path of result.excludedPaths) {
    runtime.log(`Excluded: ${sanitizeTerminalText(path)}`);
  }
}

export async function runTemplatesBuildCommand(
  projectPath: string,
  opts: TemplatesBuildOptions,
): Promise<void> {
  try {
    const result = await buildTemplateProject(projectPath, opts.out);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, stability: TEMPLATE_OUTPUT_STABILITY, ok: true });
      return;
    }
    runtime.log(
      `Built Template: ${sanitizeTerminalText(result.template.name)}@${sanitizeTerminalText(result.template.version)}`,
    );
    runtime.log(`Artifact: ${sanitizeTerminalText(result.artifact)}`);
    runtime.log(`Integrity: ${sanitizeTerminalText(result.integrity)}`);
    runtime.log(`Excluded project paths: ${result.excludedPaths.length}`);
  } catch (error) {
    reportProjectError(
      error,
      "project_build_failed",
      TEMPLATE_BUILD_RESULT_SCHEMA_VERSION,
      opts.json,
    );
  }
}

export async function runTemplatesDevCommand(
  projectPath: string,
  opts: TemplatesDevOptions,
): Promise<void> {
  let build: Awaited<ReturnType<typeof buildTemplateProject>>;
  let plan: TemplateAddPlan;
  try {
    await using workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-template-dev-",
    });
    build = await buildTemplateProject(projectPath, workspace.path("template.tgz"));
    await using extracted = await extractBuiltTemplateArtifact(build.artifact);
    const result = await readTemplateManifestFile(extracted.packageRoot);
    if (!result.ok) {
      throw new TemplateProjectError(
        "artifact_verification_failed",
        formatTemplateDiagnostics(result.diagnostics),
      );
    }
    const configSnapshot = await readConfigFileSnapshot({
      observe: false,
      skipPluginValidation: true,
    });
    if (!configSnapshot.valid) {
      throw new TemplateProjectError(
        "config_unavailable",
        "OpenClaw config is invalid; fix it before previewing a Template project.",
      );
    }
    const config = configSnapshot.resolved;
    const existingMcpServers = config.mcp?.servers ?? {};
    const existingAgentIds = listAgentIds(config);
    plan = await buildTemplateAddPlan({
      manifest: result.manifest,
      templateMarkdownBody: result.templateMarkdownBody,
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
        sourceReferenceRoot: `template-artifact:${build.integrity}`,
      },
    });
  } catch (error) {
    reportProjectError(error, "project_dev_failed", TEMPLATE_DEV_RESULT_SCHEMA_VERSION, opts.json);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: TEMPLATE_DEV_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      offline: true,
      mutationAllowed: false,
      build: {
        integrity: build.integrity,
        byteLength: build.byteLength,
        files: build.files,
        excludedPaths: build.excludedPaths,
        template: build.template,
      },
      plan,
    });
  } else {
    runtime.log(
      `Template dev preview: ${sanitizeTerminalText(build.template.name)}@${sanitizeTerminalText(build.template.version)}`,
    );
    runtime.log(`Artifact integrity: ${sanitizeTerminalText(build.integrity)}`);
    runtime.log(`Agent: ${sanitizeTerminalText(plan.agent.finalId)}`);
    runtime.log(`Workspace: ${sanitizeTerminalText(plan.agent.workspace)}`);
    logTemplateAgentConfiguration(plan);
    runtime.log(`Actions: ${plan.summary.totalActions}`);
    runtime.log(`Capability escalations: ${plan.capabilityChanges.length}`);
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
    if (plan.blockers.length > 0) {
      runtime.error(formatTemplateDiagnostics(plan.blockers));
    }
  }
  if (plan.blockers.length > 0) {
    runtime.exit(1);
  }
}
