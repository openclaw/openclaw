// Private MCP configuration and App bridge operations for the bundled Codex plugin.
// Workspace preparation and MCP metadata remain separate from live run resources.
import { pinExecToolTarget } from "../agents/exec-tool-target-pinning.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import {
  resolveAgentHarnessScheduledToolProjectionCapability,
  resolveAgentHarnessTtsProvenanceTransferCapability,
  type AgentHarnessScheduledToolProjectionFactory,
  type AgentHarnessTtsProvenanceTransfer,
} from "../agents/harness/host-private-capabilities.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";

export { pinExecToolTarget };
export { resolveBootstrapFilesForPreparation } from "../agents/bootstrap-files.js";
export { loadCodexBundleMcpApprovalConfig } from "../agents/codex-mcp-config.js";
export {
  formatMcpCodexApprovalRemedy,
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "../agents/mcp-codex-tool-approval.js";
export type CodexScheduledToolProjectionFactory = AgentHarnessScheduledToolProjectionFactory;
export type CodexTtsProvenanceTransfer = AgentHarnessTtsProvenanceTransfer;

// Native mode pins shell_tool after managed-policy preflight; the pinned registry has no disabled shells.
// A shell-disabled custom model invalidates read/exec inference; Codex exposes no shell_type fact.
// Write, patch, and process remain unobserved model/sandbox capabilities and are never inferred.
const CODEX_NATIVE_CRON_CREATOR_AUTHORITY = ["read", "exec"] as const;

/** Resolve the private scheduled-tool projection issuer for the Codex harness owner. */
export function resolveCodexScheduledToolProjectionFactory(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexScheduledToolProjectionFactory | undefined {
  return resolveAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

/** Resolve private TTS delivery transfer for the bundled Codex harness owner. */
export function resolveCodexTtsProvenanceTransfer(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexTtsProvenanceTransfer | undefined {
  return resolveAgentHarnessTtsProvenanceTransferCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

export {
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  buildCodexUserMcpServersThreadConfigPatchForRun,
  resolveCodexMcpToolOverridesForAgent,
} from "../agents/cli-runner/bundle-mcp-codex.js";
export {
  runWithCronCreatorAuthorityCapabilityResolver,
  runWithCronCreatorAuthorityResolver,
} from "../agents/cron-creator-authority-context.js";

/** Materialize static configured MCP under the Codex harness authority envelope. */
export async function materializeStaticMcpToolsForHarnessRun(
  params: Parameters<
    typeof import("../agents/agent-bundle-mcp-harness.js").materializeStaticMcpToolsForHarnessRunCore
  >[0],
) {
  const { materializeStaticMcpToolsForHarnessRunCore: materialize } =
    await import("../agents/agent-bundle-mcp-harness.js");
  return materialize(params);
}

/** Capture the final Codex dynamic-tool surface for cron creator authority. */
export async function captureFinalCodexCronCreatorToolAllowlist(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly AnyAgentTool[],
  options: { nativeToolSurfaceEnabled?: boolean } = {},
) {
  const { captureFinalEffectiveCronCreatorToolAllowlist: capture } =
    await import("../agents/tools/cron-tool.js");
  return capture(target, captureRef, tools, (tool) => getPluginToolMeta(tool), {
    canonicalToolNames: options.nativeToolSurfaceEnabled
      ? CODEX_NATIVE_CRON_CREATOR_AUTHORITY
      : undefined,
  });
}

/** Harness-owned form authority without Gateway dispatch internals. */
export type AgentHarnessMcpFormResourceParamsV1 = {
  version: 1;
  requestId: string | number;
  snapshot: Record<string, unknown>;
  signal: AbortSignal;
  origin: {
    runtime: import("../agents/agent-bundle-mcp-types.js").SessionMcpRuntime;
    serverName: string;
    agentId: string;
    sessionKey: string;
    requesterId?: string;
    assertCurrent: () => void;
    prepareToolCall?: (request: {
      toolName: string;
      input: Record<string, unknown>;
      assertCurrent: () => void;
      signal?: AbortSignal;
    }) => Promise<void>;
  };
};

/** Bind rich-form resources to the exact originating harness MCP connection. */
export async function createHarnessMcpFormResourceContext(
  params: AgentHarnessMcpFormResourceParamsV1,
) {
  const { createMcpAppFormResourceContext } = await import("../gateway/mcp-app-form-resources.js");
  params.origin.assertCurrent();
  const { prepareMcpAppFormUpload } = await import("../agents/mcp-form-resource-upload.js");
  const prepare = params.origin.prepareToolCall;
  const origin = {
    ...params.origin,
    // Gateway request options stay with the Gateway. A native harness receives
    // only the exact tool and a closure-bound current-authority assertion.
    prepareToolCall: prepare
      ? async ({
          toolName,
          input,
          assertCurrent,
          signal,
        }: {
          toolName: string;
          input: Record<string, unknown>;
          assertCurrent: () => void;
          signal?: AbortSignal;
        }) => prepare({ toolName, input, assertCurrent, signal })
      : undefined,
  };
  return await createMcpAppFormResourceContext({
    origin,
    requestId: params.requestId,
    snapshot: params.snapshot,
    signal: params.signal,
    uploadResources: await prepareMcpAppFormUpload(origin),
  });
}

export type {
  AgentHarnessSessionRuntimeParamsV1,
  AgentHarnessSessionPreparationV1,
} from "../agents/harness/types.js";
export { captureMcpClientElicitation } from "../agents/mcp-client-elicitation.js";
export {
  readMcpAppIcons,
  readMcpAppSettingsCapability,
  readMcpAppToolExtensions,
} from "../agents/mcp-app-extension-metadata.js";
export { normalizeMcpCodexToolAnnotations } from "../agents/mcp-codex-tool-approval.js";
