import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { StatelessTemplateAddOptions } from "./add-stateless.js";
import type { ClawHubCoordinate } from "./clawhub-source.js";
import type { TemplateSetupReport } from "./conversation.js";
import type { PersistedTemplateCronRef } from "./cron.js";
import type { GatewayTemplateAddPlanningContext } from "./gateway-add-plan.js";
import type { TemplateAddPlan } from "./types.js";

type TemplateAgentConfig = TemplateAddPlan["agent"]["config"];

export type ChatTemplateAddInput = ClawHubFetchOptions & {
  source: ClawHubCoordinate;
  /** Retry the admitted agent; never allocate another identity. */
  resume?: true;
  acknowledgeClawHubRisk?: boolean;
  getPlanningContext: () => Promise<GatewayTemplateAddPlanningContext>;
  assertCurrent: () => void;
  signal?: AbortSignal;
  stateDir?: string;
  reloadPlugins?: PluginInstallBatchReload;
  configWriteOptions?: StatelessTemplateAddOptions["configWriteOptions"];
  waitForAgentRuntime?: StatelessTemplateAddOptions["waitForAgentRuntime"];
  rollbackNewAgent?: (
    agentId: string,
    expectedAgentConfig: TemplateAgentConfig,
    expectedCronJobs: PersistedTemplateCronRef[],
  ) => Promise<void>;
  /** Creation has finished; the agent's first turn starts here with its outcome. */
  onAgentCreated?: (
    agent: { agentId: string; sessionKey: string },
    report: TemplateSetupReport,
  ) => Promise<void>;
};
