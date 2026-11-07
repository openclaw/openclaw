import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ControlUiRootState } from "./control-ui-root-state.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";

export type ControlUiRequestOptions = Partial<GatewayHttpRequestAuthOptions> & {
  basePath?: string;
  config?: OpenClawConfig;
  terminalEnabled?: boolean;
  agentId?: string;
  root?: ControlUiRootState;
  /** Protected session-entry restores the canonical route before any app script runs. */
  sessionEntryPath?: string;
  isSessionEntryCurrent?: () => boolean;
  /** Startup owns the asset-free recovery document; static serving detects missing bytes. */
  onUnavailableDocument?: () => boolean;
};
