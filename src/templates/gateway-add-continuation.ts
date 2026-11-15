import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StatelessTemplateAddOptions } from "./add-stateless.js";
import type { ClawHubCoordinate } from "./clawhub-source.js";

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
