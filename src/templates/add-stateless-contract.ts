import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TemplateInstallEvent } from "../shared/template-install-notice.js";
import type { TemplateInitializationIntent } from "./add-initialization-intent.js";
import type { TEMPLATE_ADD_RESULT_SCHEMA_VERSION } from "./add.js";
import type { PersistedTemplateCronRef } from "./cron-records.js";
import type { TemplateCronGateway } from "./cron.js";
import type { PersistedTemplateMcpServerRef } from "./mcp-records.js";
import type {
  TemplatePluginInstallConsent,
  TemplateSkillInstallConsent,
} from "./package-install-options.js";
import type { TemplatePackageReceipt } from "./package-stateless-receipt.js";
import type { TemplatePluginRuntimeOptions } from "./plugin-runtime.js";
import type { TemplateMutationStateOptions } from "./state-mutation-options.js";
import type { TEMPLATE_OUTPUT_STABILITY, TemplateAddPlan } from "./types.js";
import type { PersistedTemplateWorkspaceFile } from "./workspace-state.js";

export type ConfigCommit = (
  transform: (config: OpenClawConfig, runtimeConfig?: OpenClawConfig) => OpenClawConfig,
) => Promise<void>;

export type TemplateConfiguredAgentCheckpoint = {
  config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
  workspaceIdentity: string;
  /** Plan content normalized across verified source extraction roots. */
  planDigest: string;
  /** Manifest, profile, bootstrap and declared workspace source bytes. */
  sourceIntegrity: string;
};

export type StatelessTemplateAddOptions = TemplateMutationStateOptions & {
  /** Exact in-flight ordinary admission, not permission to merge an existing agent. */
  admittedAgent?: {
    config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
    workspaceIdentity: string;
    phase?: "admitted" | "configured";
    preparing?: TemplateInitializationIntent;
    planDigest?: string;
    sourceIntegrity?: string;
    assertCurrent: () => Promise<void>;
    /**
     * The caller created this admission and removes it when the Template's agent
     * configuration was never committed: rethrow that failure instead of reporting a kept agent.
     */
    discardOnFailure?: true;
  };
  assertForwardCurrent?: () => void;
  assertReviewedConfig?: (config: OpenClawConfig, phase?: "after-agent-commit") => void;
  getCurrentConfig?: () => OpenClawConfig;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  consentPlanIntegrity?: string;
  pluginConsent?: TemplatePluginInstallConsent;
  skillConsent?: TemplateSkillInstallConsent;
  reloadPlugins?: PluginInstallBatchReload;
  runtimeBatch?: TemplatePluginRuntimeOptions["runtimeBatch"];
  cronGateway?: Pick<TemplateCronGateway, "add" | "writeScratch" | "enable"> &
    Partial<Pick<TemplateCronGateway, "get" | "remove">>;
  commitConfig?: ConfigCommit;
  /** Save ordinary session state before publishing its new agent; returns exact owned cleanup. */
  prepareAgentSession?: (config: OpenClawConfig) => Promise<() => Promise<void>>;
  /** Write-ahead ownership through the canonical pending session. */
  onAgentConfiguring?: (intent: TemplateInitializationIntent) => Promise<void>;
  /** Persist verified configuration before runtime wait. Uncertain acknowledgement retains custody. */
  onAgentConfigured?: (checkpoint: TemplateConfiguredAgentCheckpoint) => Promise<void>;
  /** Confirm active runtime publication before transferring rollback custody. */
  waitForAgentRuntime?: (retainedAgent?: {
    agentId: string;
    config: TemplateConfiguredAgentCheckpoint["config"];
  }) => Promise<"applied" | "applied-restart-required">;
  /** Instructions, canonical chat, and active runtime are ready; setup continues here. */
  onAgentReady?: (agent: { agentId: string; sessionKey: string }) => Promise<void>;
  /** Publish each actual installation outcome without a model recap. */
  onSetupEvent?: (event: TemplateInstallEvent) => Promise<void>;
  configWriteOptions?: ConfigWriteOptions;
  rollbackNewAgent?: (plan: TemplateAddPlan, cronJobs: PersistedTemplateCronRef[]) => Promise<void>;
};

export type StatelessTemplateAddResult = {
  schemaVersion: typeof TEMPLATE_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof TEMPLATE_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  agentRetained?: true;
  template: TemplateAddPlan["template"];
  agent: TemplateAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedTemplateWorkspaceFile[];
  packages: TemplatePackageReceipt[];
  mcpServers: PersistedTemplateMcpServerRef[];
  cronJobs: PersistedTemplateCronRef[];
  error?: { code: string; message: string };
};
