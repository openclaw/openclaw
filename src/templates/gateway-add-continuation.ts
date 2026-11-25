import { rmdir } from "node:fs/promises";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { StatelessTemplateAddOptions } from "./add-stateless-contract.js";
import type { ClawHubCoordinate } from "./clawhub-source.js";
import type { ChatTemplateAddInput, PreparedAgentChat } from "./gateway-add-input.js";

type Initialization = NonNullable<SessionEntry["templateInitialization"]>;
export type AdmittedTemplateAgent = {
  agentId: string;
  workspace: string;
  config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
  chat: PreparedAgentChat;
  workspaceIdentity: string;
  deviceTimeZone?: string;
  configured?: Initialization["configured"];
  preparing?: Initialization["preparing"];
  /** This request created the agent and chat, so it alone may remove them. */
  createdByRequest?: true;
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
    await pending.chat.checkpoint({
      ...initialization,
      ...(pending.deviceTimeZone ? { deviceTimeZone: pending.deviceTimeZone } : {}),
    });
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
 * Refuse Add after removing an agent this request admitted before any Template write.
 * Return to the caller's kept-agent outcome if this request does not own removal or
 * removing the agent fails. Once removed, rethrow the original refusal even if chat
 * cleanup fails, so a removed agent is never reported as kept.
 */
export async function refuseAdmittedTemplateAgent(
  admitted: AdmittedTemplateAgent | undefined,
  input: Pick<ChatTemplateAddInput, "rollbackNewAgent" | "signal">,
  stateContext: OpenClawStateWorkerContext,
  refusal: Error,
): Promise<void> {
  const { rollbackNewAgent, signal } = input;
  if (!admitted?.createdByRequest || !rollbackNewAgent) {
    return;
  }
  const { agentId, config, chat, workspace } = admitted;
  let removed = false;
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
        removed = true;
        await chat();
      },
    );
  } catch (error) {
    if (!removed) {
      defaultRuntime.log(`Refused Template Add kept its new agent: ${coerceErrorMessage(error)}`);
      return;
    }
    defaultRuntime.log(
      `Refused Template Add removed its new agent but not its conversation: ${coerceErrorMessage(error)}`,
    );
  }
  await rmdir(workspace).catch(() => {});
  throw refusal;
}
