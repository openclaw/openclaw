import { rmdir } from "node:fs/promises";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { StatelessTemplateAddOptions } from "./add-stateless.js";
import type { ClawHubCoordinate } from "./clawhub-source.js";
import type { TemplateAddPlan } from "./types.js";

type Initialization = NonNullable<SessionEntry["templateInitialization"]>;
export type PreparedAgentChat = (() => Promise<void>) & {
  assertCurrent?: () => Promise<void>;
  complete?: () => Promise<void>;
  checkpoint?: (initialization: Initialization) => Promise<void>;
};
export type AdmittedTemplateAgent = {
  agentId: string;
  workspace: string;
  config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
  chat: PreparedAgentChat;
  workspaceIdentity: string;
  configured?: Initialization["configured"];
  preparing?: Initialization["preparing"];
};

/** Adapt installer checkpoints to the existing pending-session owner, not a second ledger. */
export function templateInitializationCheckpoints(
  pending: AdmittedTemplateAgent,
  source: ClawHubCoordinate,
): Pick<StatelessTemplateAddOptions, "onAgentConfiguring" | "onAgentConfigured"> {
  const checkpoint = async (initialization: Initialization) => {
    if (!pending.chat.checkpoint) {
      throw new Error("Template initialization checkpoint owner is unavailable");
    }
    await pending.chat.checkpoint(initialization);
  };
  return {
    onAgentConfiguring: async (preparing) => {
      await checkpoint({
        source,
        agentConfig: pending.config,
        workspaceIdentity: pending.workspaceIdentity,
        preparing,
      });
      pending.preparing = preparing;
    },
    onAgentConfigured: async (configuredAgent) => {
      const configured = {
        planDigest: configuredAgent.planDigest,
        sourceIntegrity: configuredAgent.sourceIntegrity,
      };
      await checkpoint({
        source,
        agentConfig: configuredAgent.config,
        workspaceIdentity: configuredAgent.workspaceIdentity,
        configured,
      });
      pending.config = structuredClone(configuredAgent.config);
      pending.workspaceIdentity = configuredAgent.workspaceIdentity;
      pending.configured = configured;
      pending.preparing = undefined;
    },
  };
}

/**
 * Remove an agent this request admitted when it was refused before any Template write.
 * Returns false, leaving the agent kept, when the removal itself fails.
 */
export async function discardAdmittedTemplateAgent(
  admitted: AdmittedTemplateAgent,
  rollbackNewAgent: (
    agentId: string,
    expectedAgentConfig: TemplateAddPlan["agent"]["config"],
    expectedCronJobs: [],
  ) => Promise<void>,
  signal: AbortSignal | undefined,
  stateContext: OpenClawStateWorkerContext,
): Promise<boolean> {
  const { agentId, config, chat, workspace } = admitted;
  try {
    await withOpenClawStateLeaseAsync(
      {
        scope: "core:agent-deletion",
        key: agentId,
        leaseMs: 60_000,
        waitMs: 5_000,
        heartbeat: "worker",
        signal,
        leaseLabel: "Template add rollback",
        operationLabel: "template.add.rollback",
      },
      stateContext,
      async () => {
        await rollbackNewAgent(
          agentId,
          { ...config, id: agentId, workspace: config.workspace ?? workspace },
          [],
        );
        await chat();
      },
    );
  } catch (error) {
    defaultRuntime.log(`Refused Template Add kept its new agent: ${coerceErrorMessage(error)}`);
    return false;
  }
  await rmdir(workspace).catch(() => {});
  return true;
}
