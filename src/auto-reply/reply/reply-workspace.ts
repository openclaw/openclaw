import fs from "node:fs/promises";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveSessionEntryIngressWorkspace } from "../../agents/spawned-context.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertReplyPreprocessingActive } from "./reply-preprocessing-abort.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

type ProvisioningInput = Parameters<
  typeof import("../../agents/acp-workspace-provisioning.js").resolveAcpAgentWorkspaceProvisioningForTurn
>[0];

export async function prepareReplyWorkspace(params: {
  dir: string;
  ensureBootstrapFiles: boolean;
  skipOptionalBootstrapFiles?: string[];
  useFastTestBootstrap: boolean;
  provisioningInput: ProvisioningInput;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<Awaited<ReturnType<typeof ensureAgentWorkspace>>> {
  const { abortSignal, operatorAuthority } = params;
  const options = {
    dir: params.dir,
    ensureBootstrapFiles: params.ensureBootstrapFiles,
    skipOptionalBootstrapFiles: params.skipOptionalBootstrapFiles,
  };
  const assertCurrent = () => {
    operatorAuthority?.assertCurrent();
    assertReplyPreprocessingActive(abortSignal);
  };
  assertCurrent();
  if (params.useFastTestBootstrap) {
    await fs.mkdir(options.dir, { recursive: true });
    assertCurrent();
    return { dir: options.dir };
  }
  const { resolveAcpAgentWorkspaceProvisioningForTurn } =
    await import("../../agents/acp-workspace-provisioning.js");
  const provisioning = await resolveAcpAgentWorkspaceProvisioningForTurn(params.provisioningInput);
  assertCurrent();
  const workspace = await ensureAgentWorkspace({
    ...options,
    provisioning,
    guard: { assertHost: assertCurrent },
  });
  assertCurrent();
  return workspace;
}

export function resolveReplyStagingWorkspace(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId: string;
  sessionKey: string;
  ctx: Parameters<typeof resolveRuntimePolicySessionKey>[0]["ctx"];
  sessionEntry: SessionEntry;
  workspaceDir: string;
}): string {
  return (
    resolveSessionEntryIngressWorkspace(
      params.sessionEntry,
      resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: params.provider,
        modelId: params.modelId,
        agentId: params.agentId,
        sessionKey: resolveRuntimePolicySessionKey(params),
        sessionEntry: params.sessionEntry,
      }),
    ) ?? params.workspaceDir
  );
}
