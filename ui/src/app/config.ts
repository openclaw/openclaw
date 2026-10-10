import { normalizeRouteBasePath } from "@openclaw/uirouter";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  type ControlUiBootstrapConfig,
  type ControlUiEmbedSandboxMode,
  type ControlUiEnvironment,
  type ControlUiPluginFrameGrantAck,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../../src/gateway/control-ui-plugin-frame-contract.js";
import { registerListener } from "../../../src/shared/listeners.js";
import { uiDevGatewayResourceUrl } from "../dev-gateway.ts";
import { normalizeAssistantIdentity } from "../lib/assistant-identity.ts";
import { resolveControlUiAuthCandidates, type ControlUiAuthSource } from "./control-ui-auth.ts";
import { applyControlUiOperatorSeamColor } from "./control-ui-presentation.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";

type ApplicationConfig = {
  assistantIdentity: ReturnType<typeof normalizeAssistantIdentity>;
  serverVersion: string | null;
  serverBuildId?: string | null;
  devGitBranch: string | null;
  environment: ControlUiEnvironment | null;
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  automaticallyFetchFavicons: boolean;
  remoteImageOrigins: readonly string[];
  communityInvite: boolean;
  /** Null until the serving Gateway publishes its bootstrap policy. */
  newSessionModelDefaults?: "last-used" | "configured" | null;
  terminalEnabled: boolean;
  uploadsEnabled: boolean;
  cliAgentsEnabled?: boolean;
  pluginAssetsRequireAuth: boolean;
  pluginFrameGrants: ControlUiPluginFrameGrantAck[];
};

export type ApplicationConfigCapability = ReturnType<typeof createApplicationConfigCapability>;

function readDocumentTerminalEnabled(): boolean | null {
  if (typeof document === "undefined") {
    return null;
  }
  const value = document.documentElement.getAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
  return value === "true" ? true : value === "false" ? false : null;
}

const DEFAULT_APPLICATION_CONFIG: ApplicationConfig = {
  assistantIdentity: normalizeAssistantIdentity(),
  serverVersion: null,
  serverBuildId: null,
  devGitBranch: null,
  environment: null,
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
  automaticallyFetchFavicons: false,
  remoteImageOrigins: [],
  communityInvite: false,
  newSessionModelDefaults: null,
  terminalEnabled: readDocumentTerminalEnabled() ?? false,
  uploadsEnabled: true,
  cliAgentsEnabled: false,
  pluginAssetsRequireAuth: true,
  pluginFrameGrants: [],
};

function loadControlUiPresentation(
  environment: ControlUiEnvironment | null,
  seamColor: string | undefined,
  isCurrent: () => boolean,
) {
  const root = document.documentElement;
  if (
    environment ||
    seamColor ||
    root.hasAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE) ||
    root.style.getPropertyValue("--ring")
  ) {
    void import("./control-ui-environment-presentation.runtime.ts").then(
      ({ applyControlUiPresentation }) => {
        if (isCurrent()) {
          applyControlUiPresentation({ environment, seamColor });
        }
      },
    );
  }
}

function normalizeApplicationConfig(parsed: ControlUiBootstrapConfig): ApplicationConfig {
  return {
    assistantIdentity: normalizeAssistantIdentity({
      agentId: parsed.assistantAgentId,
      name: parsed.assistantName,
      avatar: parsed.assistantAvatar,
      avatarSource: parsed.assistantAvatarSource,
      avatarStatus: parsed.assistantAvatarStatus,
      avatarReason: parsed.assistantAvatarReason,
    }),
    serverVersion: parsed.serverVersion ?? null,
    serverBuildId: parsed.serverBuildId ?? null,
    devGitBranch: parsed.devGitBranch?.trim() || null,
    environment: parsed.environment ?? null,
    embedSandboxMode: parsed.embedSandbox ?? "scripts",
    allowExternalEmbedUrls: Boolean(parsed.allowExternalEmbedUrls),
    automaticallyFetchFavicons: Boolean(parsed.automaticallyFetchFavicons),
    remoteImageOrigins: parsed.remoteImageOrigins ?? [],
    communityInvite: parsed.communityInvite === true,
    newSessionModelDefaults: parsed.newSessionModelDefaults ?? "last-used",
    terminalEnabled: Boolean(parsed.terminalEnabled),
    uploadsEnabled: parsed.uploadsEnabled !== false,
    cliAgentsEnabled: Boolean(parsed.cliAgentsEnabled),
    pluginAssetsRequireAuth: parsed.pluginAssetsRequireAuth !== false,
    pluginFrameGrants: (parsed.pluginFrameGrants ?? [])
      .filter(
        (grant): grant is ControlUiPluginFrameGrantAck =>
          typeof grant?.pluginId === "string" &&
          typeof grant.path === "string" &&
          (grant.match === "exact" || grant.match === "prefix"),
      )
      .map((grant) => ({
        pluginId: grant.pluginId,
        path: uiDevGatewayResourceUrl(grant.path),
        match: grant.match,
      })),
  };
}

async function loadApplicationConfig(params: {
  url: string;
  authCandidates: readonly string[];
  signal?: AbortSignal;
}): Promise<{ config: ApplicationConfig; seamColor?: string } | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }

  try {
    let res: Response | null = null;
    for (const candidate of params.authCandidates.length ? params.authCandidates : [""]) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (candidate) {
        headers.Authorization = `Bearer ${candidate}`;
      }
      res = await fetch(params.url, {
        method: "GET",
        headers,
        credentials: "same-origin",
        signal: params.signal,
      });
      if (res.ok) {
        break;
      }
      if (res.status !== 401 && res.status !== 403) {
        return null;
      }
    }
    if (!res?.ok) {
      return null;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    return { config: normalizeApplicationConfig(parsed), seamColor: parsed.seamColor };
  } catch {
    return null;
  }
}

export function createApplicationConfigCapability(params: {
  resourceBasePath: string;
  getAuth?: () => ControlUiAuthSource;
}) {
  let current = DEFAULT_APPLICATION_CONFIG;
  let authVersion = 0;
  let refreshVersion = 0;
  let publishedVersion = 0;
  const environmentAttribute = document.documentElement.getAttribute(
    CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  );
  if (environmentAttribute) {
    current = {
      ...current,
      environment: JSON.parse(environmentAttribute),
    };
  }
  const url = `${normalizeRouteBasePath(params.resourceBasePath)}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;
  const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
  const resolveAuth = () =>
    sameOrigin ? resolveControlUiAuthCandidates(params.getAuth?.() ?? {}) : [];
  const embedded = sameOrigin
    ? document.documentElement.getAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE)
    : null;
  let loadedAt = Number.NEGATIVE_INFINITY;
  let seamColor: string | undefined;
  if (embedded) {
    const parsed: ControlUiBootstrapConfig = JSON.parse(embedded);
    if (
      normalizeRouteBasePath(parsed.basePath) === normalizeRouteBasePath(params.resourceBasePath)
    ) {
      current = normalizeApplicationConfig(parsed);
      loadedAt = Date.now();
      seamColor = parsed.seamColor;
    }
  }
  applyControlUiOperatorSeamColor(seamColor);
  loadControlUiPresentation(current.environment, seamColor, () => publishedVersion === 0);
  // Navigation credentials need not match a bearer selected by the app.
  let authCandidates: string[] = [];
  let pending: { signal?: AbortSignal; promise: Promise<ApplicationConfig | null> } | undefined;
  const listeners = new Set<(config: ApplicationConfig) => void>();

  return {
    get current() {
      return current;
    },
    async refresh(options?: { ifNeeded?: boolean; signal?: AbortSignal }) {
      // Queued bootstrap work cannot own credentials: plugin activation may
      // request its asset grant before that queue reaches the config refresh.
      const candidates = resolveAuth();
      if (
        candidates.length !== authCandidates.length ||
        candidates.some((candidate, index) => candidate !== authCandidates[index])
      ) {
        // Credential changes retire both cached config and in-flight authority.
        authCandidates = candidates;
        authVersion++;
        loadedAt = Number.NEGATIVE_INFINITY;
        pending = undefined;
      }
      if (pending && pending.signal === options?.signal) {
        return pending.promise;
      }
      if (options?.ifNeeded && Date.now() - loadedAt < CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2) {
        return current;
      }
      const version = ++refreshVersion;
      const authority = authVersion;
      const signal = options?.signal;
      const isCurrent = () => {
        const liveCandidates = resolveAuth();
        return (
          authority === authVersion &&
          !signal?.aborted &&
          candidates.length === liveCandidates.length &&
          candidates.every((candidate, index) => candidate === liveCandidates[index])
        );
      };
      const promise = loadApplicationConfig({
        url,
        authCandidates: candidates,
        signal,
      }).then((loaded) => {
        if (!loaded || !isCurrent()) {
          return null;
        }
        let next = loaded.config;
        // Independent callers keep their own abort signals and valid results;
        // only the newest successful request publishes shared presentation.
        if (version < publishedVersion) {
          return next;
        }
        publishedVersion = version;
        loadControlUiPresentation(
          next.environment,
          loaded.seamColor,
          () => isCurrent() && version === publishedVersion,
        );
        const documentTerminalEnabled = readDocumentTerminalEnabled();
        if (documentTerminalEnabled !== null && next.terminalEnabled !== documentTerminalEnabled) {
          // CSP headers cannot change on a live document. Reload in either
          // direction so the document and accepted terminal state stay aligned.
          if (canReloadControlUiDocument()) {
            window.location.reload();
            return next;
          }
          // Keep this document's CSP-bound terminal capability, but still publish
          // live renderer policy changes such as remote image-origin revocation.
          next = { ...next, terminalEnabled: documentTerminalEnabled };
        }
        current = next;
        loadedAt = Date.now();
        for (const listener of listeners) {
          listener(current);
        }
        return next;
      });
      pending = { promise, signal };
      try {
        return await promise;
      } finally {
        if (pending?.promise === promise) {
          pending = undefined;
        }
      }
    },
    subscribe: (listener: (config: ApplicationConfig) => void) =>
      registerListener(listeners, listener),
  };
}
