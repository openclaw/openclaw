import {
  CLAW_EXPORT_RESULT_SCHEMA_VERSION,
  ClawExportError,
  exportClawAgent,
} from "../claws/export.js";
import { CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { emitClawFailure, logClawExperimentalWarning } from "./claws-cli-output.js";
import type { ClawsExportOptions } from "./claws-cli.js";

export async function runClawsExportCommand(
  agentId: string,
  opts: ClawsExportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  try {
    const listedMcpServers = await listConfiguredMcpServers();
    if (!listedMcpServers.ok) {
      throw new ClawExportError("mcp_config_unavailable", listedMcpServers.error);
    }
    const result = await exportClawAgent(agentId, opts.out, {
      config: getRuntimeConfig(),
      sourceMcpServers: listedMcpServers.mcpServers,
      ...(opts.bootstrap ? { bootstrapPath: opts.bootstrap } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Exported agent: ${result.agentId}`);
    runtime.log(`Package directory: ${result.outputDirectory}`);
    runtime.log(
      `Workspace files: ${result.manifest.workspace.files.length + Object.keys(result.manifest.workspace.bootstrapFiles).length}`,
    );
    runtime.log(`Packages: ${result.manifest.packages.length}`);
    runtime.log(`Bootstrap: ${result.filesWritten.includes("BOOTSTRAP.md") ? "included" : "none"}`);
  } catch (error) {
    const code = error instanceof ClawExportError ? error.code : "export_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
  }
}
