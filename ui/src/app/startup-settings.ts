import {
  normalizeGatewayClientId,
  normalizeGatewayClientMode,
} from "@openclaw/gateway-protocol/client-info";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import {
  CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
  type ControlUiBootstrapProfileHint,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import { inferBasePathFromPathname, sessionRouteNamespaceFromPath } from "../app-route-paths.ts";
import { createNativeGatewayConnectAuth } from "./native-gateway-auth.ts";
import { resolveGatewayCredentialsForUrlEdit, type UiSettings } from "./settings.ts";

type NativeControlAuth = {
  gatewayUrl?: string | null;
  nativeConnectAuth?: boolean;
  token?: string | null;
  password?: string | null;
  client?: {
    id?: string | null;
    mode?: string | null;
    platform?: string | null;
    deviceFamily?: string | null;
    instanceId?: string | null;
    scopes?: unknown;
  } | null;
};

type NativeGatewayClientOptions = Pick<
  GatewayBrowserClientOptions,
  | "clientName"
  | "mode"
  | "platform"
  | "deviceFamily"
  | "instanceId"
  | "scopes"
  | "nativeConnectAuth"
>;

declare global {
  interface Window {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: NativeControlAuth;
  }
}

export function normalizeLegacyTerminalViewLocation(
  location: RouteLocation,
  basePath: string,
): RouteLocation {
  const applicationRoot = basePath ? `${basePath}/` : "/";
  if (location.pathname !== applicationRoot) {
    return location;
  }
  const searchParams = new URLSearchParams(location.search);
  if (searchParams.get("view") !== "terminal") {
    return location;
  }
  searchParams.delete("view");
  const search = searchParams.toString();
  return {
    pathname: buildControlUiFocusPath({ kind: "terminal" }, basePath),
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
}

export function resolveApplicationStartupSettings(
  initialSettings: UiSettings,
  location: RouteLocation,
) {
  let settings = initialSettings;
  let changed = false;
  let password: string | null = null;
  let pendingGatewayUrl: string | null = null;
  let pendingGatewayToken: string | null = null;
  let pendingBootstrapToken: string | null = null;
  let pendingBootstrapProfile: ControlUiBootstrapProfileHint | null = null;
  let nativeClient: NativeGatewayClientOptions | null = null;

  const updateSettings = (patch: Partial<UiSettings>) => {
    const entries = Object.entries(patch) as Array<
      [keyof UiSettings, UiSettings[keyof UiSettings]]
    >;
    if (entries.every(([key, value]) => settings[key] === value)) {
      return;
    }
    settings = { ...settings, ...patch };
    changed = true;
  };

  const injectedNativeAuth =
    typeof window === "undefined" ? undefined : window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  // Older Android WebViews cannot inject at document start. This public marker
  // selects native-only auth immediately; authority arrives over a main-frame port.
  // Keep the marker in the URL so a reload cannot start a browser pairing flow.
  const nativePortGateway = new URLSearchParams(location.hash.replace(/^#/, "")).get(
    "nativeControlAuth",
  );
  const nativeAuth =
    injectedNativeAuth ??
    (nativePortGateway ? { gatewayUrl: nativePortGateway, nativeConnectAuth: true } : undefined);
  if (nativeAuth) {
    try {
      delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    } catch {
      window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = undefined;
    }

    const gatewayUrl = normalizeOptionalString(nativeAuth.gatewayUrl);
    const token = normalizeOptionalString(nativeAuth.token);
    const nativePassword = normalizeOptionalString(nativeAuth.password);
    const credentials = gatewayUrl
      ? resolveGatewayCredentialsForUrlEdit(settings.gatewayUrl, gatewayUrl, {
          token: settings.token,
          password: "",
        })
      : null;
    const client = nativeAuth.client;
    const clientName = normalizeGatewayClientId(client?.id);
    const mode = normalizeGatewayClientMode(client?.mode);
    const platform = normalizeOptionalString(client?.platform);
    const deviceFamily = normalizeOptionalString(client?.deviceFamily);
    const instanceId = normalizeOptionalString(client?.instanceId);
    const scopes = normalizeUniqueTrimmedStringList(client?.scopes);
    if (clientName && mode && platform && deviceFamily && scopes.length > 0) {
      nativeClient = {
        clientName,
        mode,
        platform,
        deviceFamily,
        ...(instanceId ? { instanceId } : {}),
        scopes,
      };
    }
    if (nativeAuth.nativeConnectAuth === true && gatewayUrl) {
      nativeClient = {
        nativeConnectAuth: createNativeGatewayConnectAuth(gatewayUrl, {
          messagePort: !injectedNativeAuth && Boolean(nativePortGateway),
        }),
      };
    }
    updateSettings({
      ...(gatewayUrl ? { gatewayUrl } : {}),
      // An explicit null retires shared-owner auth for the native browser sign-in
      // route; an omitted token still preserves the selected Gateway's credentials.
      ...(nativeAuth.nativeConnectAuth === true
        ? { token: "" }
        : nativeAuth.token === null || token
          ? { token: token ?? "" }
          : credentials
            ? { token: credentials.token }
            : {}),
    });
    if (nativePassword && nativeAuth.nativeConnectAuth !== true) {
      password = nativePassword;
    }
  }

  if (!location.search && !location.hash) {
    return {
      settings,
      password,
      pendingGatewayUrl,
      pendingGatewayToken,
      pendingBootstrapToken,
      pendingBootstrapProfile,
      nativeClient,
      location,
      changed,
    };
  }

  const url = new URL(
    `${location.pathname}${location.search}${location.hash}`,
    "http://openclaw.local",
  );
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = normalizeOptionalString(gatewayUrlRaw) ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== settings.gatewayUrl);
  const queryToken = params.get("token");
  const hashToken = hashParams.get("token");
  const hasTokenParam = hashToken != null || queryToken != null;
  const token = normalizeOptionalString(hashToken ?? queryToken);
  const hasBootstrapTokenParam = hashParams.has("bootstrapToken");
  const bootstrapToken = normalizeOptionalString(hashParams.get("bootstrapToken"));
  const bootstrapProfile = normalizeOptionalString(
    hashParams.get(CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM),
  );
  const sessionPath = sessionRouteNamespaceFromPath(
    location.pathname,
    inferBasePathFromPathname(location.pathname),
  );
  const shouldResetSessionForToken = Boolean(token && !sessionPath && !gatewayUrlChanged);
  if (hasTokenParam) {
    if (queryToken != null) {
      console.warn(
        "[openclaw] Auth token passed as query parameter (?token=). Use URL fragment instead: #token=<token>. Query parameters may appear in server logs.",
      );
    }
    if (token && gatewayUrlChanged) {
      pendingGatewayToken = token;
    } else if (token) {
      updateSettings({ token });
    }
  }

  if (hasBootstrapTokenParam) {
    pendingBootstrapToken = bootstrapToken ?? null;
    pendingBootstrapProfile =
      bootstrapToken && bootstrapProfile === CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT
        ? CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT
        : null;
  }

  if (shouldResetSessionForToken) {
    updateSettings({
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (gatewayUrlRaw != null) {
    pendingGatewayUrl = gatewayUrlChanged ? nextGatewayUrl : null;
    if (!gatewayUrlChanged || pendingBootstrapToken) {
      pendingGatewayToken = null;
    }
  }

  let shouldCleanUrl = false;
  for (const source of [params, hashParams]) {
    const keys = ["token", "password", "gatewayUrl"];
    if (source === hashParams) {
      keys.push("bootstrapToken", CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM);
    }
    for (const key of keys) {
      if (source.has(key)) {
        source.delete(key);
        shouldCleanUrl = true;
      }
    }
  }

  if (shouldCleanUrl) {
    url.search = params.toString();
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }

  return {
    settings,
    password,
    pendingGatewayUrl,
    pendingGatewayToken,
    pendingBootstrapToken,
    pendingBootstrapProfile,
    nativeClient,
    location: shouldCleanUrl
      ? {
          pathname: url.pathname,
          search: url.search,
          hash: url.hash,
        }
      : location,
    changed,
  };
}
