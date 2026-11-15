import fs from "node:fs/promises";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  WorkspaceAliasRepointedError,
  WorkspaceVanishedError,
} from "../../agents/workspace-state-identity.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { logVerbose } from "../../globals.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { assertReplyPreprocessingActive } from "./reply-preprocessing-abort.js";

type ProvisioningInput = Parameters<
  typeof import("../../agents/acp-workspace-provisioning.js").resolveAcpAgentWorkspaceProvisioningForTurn
>[0];

export async function prepareReplyWorkspace(params: {
  dir: string;
  ensureBootstrapFiles: boolean;
  deferWorkspaceBootstrap?: true;
  skipOptionalBootstrapFiles?: string[];
  useFastTestBootstrap: boolean;
  provisioningInput: ProvisioningInput;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<Awaited<ReturnType<typeof ensureAgentWorkspace>>> {
  const { abortSignal, operatorAuthority } = params;
  const options = {
    dir: params.dir,
    ensureBootstrapFiles: params.ensureBootstrapFiles && !params.deferWorkspaceBootstrap,
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

/** Permanent workspace failures finish ingress even in tool-only conversations. */
export function replyForUnavailableWorkspace(error: unknown) {
  if (!(error instanceof WorkspaceAliasRepointedError || error instanceof WorkspaceVanishedError)) {
    return undefined;
  }
  // Keep host paths in operator logs.
  logVerbose(`workspace unavailable; replying with repair notice: ${error.message}`);
  const text =
    error instanceof WorkspaceAliasRepointedError
      ? "⚠️ This agent's workspace state needs repair: the configured workspace path no longer matches its stored identity. Ask the gateway operator to run `openclaw doctor --fix` and confirm the move only if the same workspace moved."
      : "⚠️ This agent's workspace is missing on the gateway host. Ask the operator to restore the workspace from backup and run `openclaw doctor`.";
  return markReplyPayloadForSourceSuppressionDelivery({ text });
}
