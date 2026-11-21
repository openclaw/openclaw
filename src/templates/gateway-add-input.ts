import type {
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { StatelessTemplateAddOptions } from "./add-stateless-contract.js";
import type { ClawHubCoordinate } from "./clawhub-source.js";
import type { TemplateSetupOpening, TemplateSetupReport } from "./conversation.js";
import type { TemplateCronGateway, PersistedTemplateCronRef } from "./cron.js";
import type { GatewayTemplateAddPlanningContext } from "./gateway-add-plan.js";
import type { TemplateAddSource, TemplateAddStageHook } from "./gateway-add-source.js";
import type { TemplateAddPlan } from "./types.js";

type TemplateAgentConfig = TemplateAddPlan["agent"]["config"];

export type PreparedAgentChat = (() => Promise<void>) & {
  assertCurrent?: () => Promise<void>;
  complete?: (templateSetup?: SessionEntry["templateSetup"]) => Promise<void>;
  checkpoint?: (
    initialization: NonNullable<SessionEntry["templateInitialization"]>,
  ) => Promise<void>;
};

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
  /**
   * Creation has finished; the agent's first turn starts here with its outcome.
   * `onModelRequested` reports that the turn has sent its first model request.
   */
  onAgentCreated?: (
    agent: { agentId: string; sessionKey: string },
    opening: TemplateSetupOpening,
    onModelRequested?: () => void,
  ) => Promise<void>;
  /** A separate hidden turn reports results after the opening, never concurrently with it. */
  onDependenciesSettled?: (
    agent: { agentId: string; sessionKey: string },
    report: TemplateSetupReport,
  ) => Promise<void>;
  /** Scheduler-owned declaration keys for this agent's setup conversation, including paused jobs. */
  readSetupAutomationKeys?: (agent: {
    agentId: string;
    sessionKey: string;
  }) => Promise<Set<string>>;
};

/** Both sources share the same installer; only registry coordinates can continue chat setup. */
export type GatewayTemplateAddInput = Omit<ChatTemplateAddInput, "source"> &
  (
    | { mode: "chat"; source: ClawHubCoordinate }
    | { mode?: undefined; source: TemplateAddSource }
  ) & {
    agentId?: string;
    onStage?: TemplateAddStageHook;
    planIntegrity?: string;
    acknowledgeCapabilities?: readonly TemplatePluginAcknowledgement[];
    acknowledgeSkillWarnings?: readonly TemplateSkillAcknowledgement[];
    policyConfig: { configPath: string; env: NodeJS.ProcessEnv };
    prepareAgentChat?: (
      agentId: string,
      config: OpenClawConfig,
      pending?: {
        initializationPending: true;
        templateInitialization?: SessionEntry["templateInitialization"];
        recover?: true;
      },
    ) => Promise<PreparedAgentChat>;
    admissionConfigWriteOptions?: StatelessTemplateAddOptions["configWriteOptions"];
    waitForAdmissionRuntime?: StatelessTemplateAddOptions["waitForAgentRuntime"];
    onAgentAdmitted?: (agent: { agentId: string; sessionKey: string }) => Promise<void>;
    onAgentReady?: StatelessTemplateAddOptions["onAgentReady"];
    onSetupEvent?: StatelessTemplateAddOptions["onSetupEvent"];
    cronGateway?: Pick<TemplateCronGateway, "add" | "writeScratch" | "enable"> &
      Partial<Pick<TemplateCronGateway, "get" | "remove">>;
  };
