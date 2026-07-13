import type {
  SessionCatalogCapabilities,
  SessionCatalogHost,
  SessionsCatalogArchiveParams,
  SessionsCatalogContinueParams,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";

export type SessionCatalogListProviderParams = {
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
};
export type SessionCatalogReadProviderParams = Omit<SessionsCatalogReadParams, "catalogId">;
export type SessionCatalogContinueProviderParams = Omit<SessionsCatalogContinueParams, "catalogId">;
export type SessionCatalogArchiveProviderParams = Omit<SessionsCatalogArchiveParams, "catalogId">;

export type SessionCatalogProvider = {
  id: string;
  label: string;
  /** Opens the core new-session flow with this model preselected. */
  createSession?: NonNullable<SessionCatalogCapabilities["createSession"]> & {
    /** Only advertise creation when this model resolves to the required agent runtime. */
    requiredAgentRuntimeId?: string;
  };
  list: (params: SessionCatalogListProviderParams) => Promise<SessionCatalogHost[]>;
  read: (params: SessionCatalogReadProviderParams) => Promise<SessionsCatalogReadResult>;
  continueSession?: (
    params: SessionCatalogContinueProviderParams,
  ) => Promise<{ sessionKey: string }>;
  archive?: (params: SessionCatalogArchiveProviderParams) => Promise<{ ok: true }>;
};
