// Cron tool type declarations shared with the cron tool implementation.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { callGatewayTool } from "./gateway.js";

export type CronCreatorToolAllowlistEntry =
  | string
  | {
      /** Canonical policy name persisted into toolsAllow caps. */
      name: string;
      pluginId?: string;
      /** Runtime-specific alias the creator surface presented for this tool. */
      aliasName?: string;
      /** Restrict-only execution policy carried by a host-created alias projection. */
      execTarget?: { host: "gateway"; ask?: "always" };
    };

type CronToolsAllowCaptureProvenance = {
  version: 1;
  source: "final-executable-surface";
};

export type CronToolsAllowCaptureRef = {
  value?: CronToolsAllowCaptureProvenance;
};

export type CronCreatorToolAuthorityMaterialization = {
  tools: readonly CronCreatorToolAllowlistEntry[];
  provenance: CronToolsAllowCaptureProvenance;
  /** Opaque runtime-owned authority captured with the same exact executable surface. */
  runtimeAuthority?: CronRuntimeAuthority;
};

type CronCreatorToolAuthoritySnapshot = Omit<
  CronCreatorToolAuthorityMaterialization,
  "runtimeAuthority"
> & {
  /** Gateway-process one-shot proof consumed only at the matching cron write. */
  grant: CronCreatorAuthorityGrant;
  /** The creator captured runtime app authority (Codex apps); its default list stays concrete. */
  holdsRuntimeAuthority?: true;
};

export type CronToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
  /** Authenticated source account; authority must not be inferred from delivery. */
  agentAccountId?: string;
  /**
   * Resolved config for the calling context. Shapes the advertised schema and
   * description: when cron.triggers.enabled is off, trigger-gated surfaces
   * (trigger, script payloads, stream schedules) are not advertised. Omitting
   * config keeps the full surface for config-less callers.
   */
  config?: OpenClawConfig;
  currentDeliveryContext?: DeliveryContext;
  /** Legacy SDK input; new cron writes do not capture or persist this tool list. */
  creatorToolAllowlist?: CronCreatorToolAllowlistEntry[];
  /** Legacy SDK capture receipt; unused by current cron writes. */
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  /** Legacy SDK resolver; current cron writes preserve requester identity without a snapshot. */
  resolveCreatorToolAuthority?: (options?: {
    signal?: AbortSignal;
  }) => Promise<CronCreatorToolAuthoritySnapshot>;
  /** Legacy SDK diagnostic; cron execution now uses the owning agent's current permissions. */
  creatorAuthorityUnavailableReason?: "queued-local-operator-configured-mcp";
  selfRemoveOnlyJobId?: string;
  runId?: string;
};

export type GatewayToolCaller = typeof callGatewayTool;

export type CronToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};
