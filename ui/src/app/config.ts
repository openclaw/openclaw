import { normalizeRouteBasePath } from "@openclaw/uirouter";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  CONTROL_UI_REMOTE_IMAGE_ORIGINS_ATTRIBUTE,
  type ControlUiBootstrapConfig,
  type ControlUiEmbedSandboxMode,
  type ControlUiEnvironment,
  type ControlUiPluginFrameGrantAck,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { uiDevGatewayResourceUrl } from "../dev-gateway.ts";
import { normalizeAssistantIdentity } from "../lib/assistant-identity.ts";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";

type ApplicationConfigAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

type ApplicationConfig = {
  assistantIdentity: {
    agentId: string | null;
    name: string;
    avatar: string | null;
    avatarSource: string | null;
    avatarStatus: "none" | "local" | "remote" | "data" | null;
    avatarReason: string | null;
  };
  serverVersion: string | null;
  serverBuildId?: string | null;
  devGitBranch: string | null;
  environment: ControlUiEnvironment | null;
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  automaticallyFetchFavicons: boolean;
  remoteImageOrigins: readonly string[];
  communityInvite: boolean;
  terminalEnabled: boolean;
  cliAgentsEnabled?: boolean;
  pluginAssetsRequireAuth: boolean;
  pluginFrameGrants: ControlUiPluginFrameGrantAck[];
};

export type ApplicationConfigCapability = {
  readonly current: ApplicationConfig;
  refresh: (options?: {
    skipWithoutAuthCandidate?: boolean;
    signal?: AbortSignal;
  }) => Promise<ApplicationConfig | null>;
  subscribe: (listener: (config: ApplicationConfig) => void) => () => void;
};

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
  terminalEnabled: readDocumentTerminalEnabled() ?? false,
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
    terminalEnabled: Boolean(parsed.terminalEnabled),
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

async function loadApplicationConfig(
  url: string,
  authCandidates: readonly string[],
  signal?: AbortSignal,
): Promise<{ config: ApplicationConfig; seamColor?: string } | null> {
  try {
    for (const candidate of authCandidates.length ? authCandidates : [""]) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (candidate) {
        headers.Authorization = `Bearer ${candidate}`;
      }
      const res = await fetch(url, {
        headers,
        credentials: "same-origin",
        signal,
      });
      if (res.ok) {
        const parsed = (await res.json()) as ControlUiBootstrapConfig;
        return { config: normalizeApplicationConfig(parsed), seamColor: parsed.seamColor };
      }
      if (res.status !== 401 && res.status !== 403) {
        break;
      }
    }
  } catch {
    // Failed bootstrap requests leave the current configuration in place.
  }
  return null;
}

function sameAuthCandidates(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((candidate, index) => candidate === right[index])
  );
}

export function createApplicationConfigCapability(params: {
  resourceBasePath: string;
  getAuth?: () => ApplicationConfigAuthSource;
}): ApplicationConfigCapability {
  let current = DEFAULT_APPLICATION_CONFIG;
  const documentImageOrigins = document.documentElement.getAttribute(
    CONTROL_UI_REMOTE_IMAGE_ORIGINS_ATTRIBUTE,
  );
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
    loadControlUiPresentation(current.environment, undefined, () => publishedVersion === 0);
  }
  const url = `${normalizeRouteBasePath(params.resourceBasePath)}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;
  const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
  const resolveAuth = () =>
    sameOrigin ? resolveControlUiAuthCandidates(params.getAuth?.() ?? {}) : [];
  let authCandidates: string[] = [];
  let pending: { signal?: AbortSignal; promise: Promise<ApplicationConfig | null> } | undefined;
  const listeners = new Set<(config: ApplicationConfig) => void>();

  return {
    get current() {
      return current;
    },
    async refresh(options) {
      // Queued bootstrap work cannot own credentials: plugin activation may
      // request its asset grant before that queue reaches the config refresh.
      const candidates = resolveAuth();
      if (!sameAuthCandidates(candidates, authCandidates)) {
        // Changing credentials retires previous authority even when this refresh
        // skips its request. Equivalent startup consumers share the live load.
        authCandidates = candidates;
        authVersion++;
        pending = undefined;
      }
      if (options?.skipWithoutAuthCandidate && sameOrigin && !candidates.length) {
        return null;
      }
      if (pending && pending.signal === options?.signal) {
        return pending.promise;
      }
      const version = ++refreshVersion;
      const authority = authVersion;
      const signal = options?.signal;
      const isCurrent = () => {
        const liveCandidates = resolveAuth();
        return (
          authority === authVersion &&
          !signal?.aborted &&
          sameAuthCandidates(candidates, liveCandidates)
        );
      };
      const promise = loadApplicationConfig(url, candidates, signal).then((loaded) => {
        if (!loaded || !isCurrent()) {
          return null;
        }
        const next = loaded.config;
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
        if (
          (documentTerminalEnabled !== null && next.terminalEnabled !== documentTerminalEnabled) ||
          (documentImageOrigins !== null &&
            JSON.stringify(next.remoteImageOrigins) !== documentImageOrigins)
        ) {
          // CSP headers cannot change on a live document. Reload in either
          // direction so the document and accepted browser permissions stay aligned.
          if (canReloadControlUiDocument()) {
            window.location.reload();
          }
          return next;
        }
        current = next;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
