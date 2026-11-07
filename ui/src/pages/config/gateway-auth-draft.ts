import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { REDACTED_SENTINEL, removePathValue, setPathValue } from "../../lib/config-form-utils.ts";
import { t } from "../../lib/reactive/i18n.ts";

// Gateway auth edits stay out of the shared config draft: autosave writes the
// whole draft, so a half-made mode change would otherwise lock the browser out.
// The config page stages them here and the Authentication card applies mode and
// credentials together as one base-hash-checked config.patch.

export const GATEWAY_AUTH_MODES = ["token", "password", "trusted-proxy", "none"] as const;
export type GatewayAuthMode = (typeof GATEWAY_AUTH_MODES)[number];

export type GatewayAuthIssue =
  | "tokenRequired"
  | "passwordRequired"
  | "userHeaderRequired"
  | "trustedProxiesRequired";

export type BrowserCredential = { token: string } | { password: string };

type AuthRecord = Record<string, unknown>;
type ConfigPath = ReadonlyArray<string | number>;

/** The auth the edit started from and the staged result; base anchors the patch. */
export type GatewayAuthDraft = { base: AuthRecord; next: AuthRecord };

export function isGatewayAuthPath(path: ConfigPath): boolean {
  return path[0] === "gateway" && path[1] === "auth";
}

export function readGatewayAuth(config: unknown): AuthRecord {
  return structuredClone(
    asNullableRecord(asNullableRecord(asNullableRecord(config)?.gateway)?.auth) ?? {},
  );
}

/** Applies one form edit under gateway.auth to the staged auth. */
export function stageGatewayAuthEdit(
  draft: GatewayAuthDraft,
  path: ConfigPath,
  edit: { value: unknown } | "remove",
): GatewayAuthDraft {
  const relative = path.slice(2) as Array<string | number>;
  if (relative.length === 0) {
    const next = edit === "remove" ? {} : (asNullableRecord(structuredClone(edit.value)) ?? {});
    return { base: draft.base, next };
  }
  const next = structuredClone(draft.next);
  const [field] = relative;
  if (
    edit !== "remove" &&
    relative.length === 1 &&
    (field === "token" || field === "password") &&
    edit.value === ""
  ) {
    // Clearing a secret input keeps the saved secret rather than blanking it.
    if (draft.base[field] === undefined) {
      delete next[field];
    } else {
      next[field] = structuredClone(draft.base[field]);
    }
  } else if (edit === "remove") {
    removePathValue(next, relative);
  } else {
    setPathValue(next, relative, edit.value);
  }
  return { base: draft.base, next };
}

/** The form shows staged auth values without putting them in the autosaved draft. */
export function withGatewayAuthDraft(
  config: Record<string, unknown> | null,
  draft: GatewayAuthDraft | null,
): Record<string, unknown> | null {
  if (!config || !draft) {
    return config;
  }
  return { ...config, gateway: { ...asNullableRecord(config.gateway), auth: draft.next } };
}

export function gatewayAuthMode(auth: Readonly<AuthRecord>): GatewayAuthMode {
  const mode = auth.mode;
  if (typeof mode === "string" && (GATEWAY_AUTH_MODES as readonly string[]).includes(mode)) {
    return mode as GatewayAuthMode;
  }
  // Without a mode the Gateway uses password auth when a password is set, otherwise token.
  return hasCredential(auth.password) ? "password" : "token";
}

/** A saved (redacted) secret or a SecretRef counts; the Gateway checks it on apply. */
function hasCredential(value: unknown): boolean {
  if (typeof value === "string") {
    return value === REDACTED_SENTINEL || value.trim() !== "";
  }
  return asNullableRecord(value) !== null;
}

/**
 * Why Apply stays disabled for the staged auth, or null when it can be applied.
 * Keeping the current mode never demands a credential here: it may come from
 * the environment or a startup override the page cannot see.
 */
export function gatewayAuthIssue(
  draft: GatewayAuthDraft,
  config: unknown,
): GatewayAuthIssue | null {
  const mode = gatewayAuthMode(draft.next);
  const modeChanged = mode !== gatewayAuthMode(draft.base);
  switch (mode) {
    case "token":
      return !modeChanged || hasCredential(draft.next.token) ? null : "tokenRequired";
    case "password":
      return !modeChanged || hasCredential(draft.next.password) ? null : "passwordRequired";
    case "trusted-proxy": {
      const userHeader = asNullableRecord(draft.next.trustedProxy)?.userHeader;
      if (typeof userHeader !== "string" || userHeader.trim() === "") {
        return "userHeaderRequired";
      }
      const proxies = asNullableRecord(asNullableRecord(config)?.gateway)?.trustedProxies;
      return Array.isArray(proxies) && proxies.length > 0 ? null : "trustedProxiesRequired";
    }
    case "none":
      return null;
  }
}

/** Trusted-proxy and token auth are mutually exclusive, so applying it drops the token. */
function gatewayAuthToApply(auth: Readonly<AuthRecord>): AuthRecord {
  if (gatewayAuthMode(auth) !== "trusted-proxy") {
    return { ...auth };
  }
  const { token: _token, ...rest } = auth;
  return rest;
}

/** RFC 7396 merge patch that turns `from` into `to`; null removes a key. */
export function mergePatchBetween(
  from: Readonly<AuthRecord>,
  to: Readonly<AuthRecord>,
): AuthRecord {
  const patch: AuthRecord = {};
  for (const [key, value] of Object.entries(to)) {
    const previous = asNullableRecord(from[key]);
    const next = asNullableRecord(value);
    if (previous && next && !Array.isArray(from[key]) && !Array.isArray(value)) {
      const nested = mergePatchBetween(previous, next);
      if (Object.keys(nested).length > 0) {
        patch[key] = nested;
      }
    } else if (JSON.stringify(from[key]) !== JSON.stringify(value)) {
      patch[key] = value;
    }
  }
  for (const key of Object.keys(from)) {
    if (!Object.hasOwn(to, key)) {
      patch[key] = null;
    }
  }
  return patch;
}

function arrayPaths(patch: Readonly<AuthRecord>, prefix: string): string[] {
  return Object.entries(patch).flatMap(([key, value]) => {
    const path = `${prefix}.${key}`;
    if (Array.isArray(value)) {
      return [path];
    }
    const nested = asNullableRecord(value);
    return nested ? arrayPaths(nested, path) : [];
  });
}

/** The one config.patch that carries the mode and its credentials together. */
export function gatewayAuthPatch(draft: GatewayAuthDraft): {
  patch: AuthRecord;
  replacePaths: string[];
} {
  const patch = mergePatchBetween(draft.base, gatewayAuthToApply(draft.next));
  return { patch, replacePaths: arrayPaths(patch, "gateway.auth") };
}

/**
 * The secret this browser must present once the staged auth applies, when it was
 * typed here. Saved secrets and SecretRefs are unknown to the page, so it keeps
 * its current credential for them.
 */
export function browserCredentialAfterApply(draft: GatewayAuthDraft): BrowserCredential | null {
  const mode = gatewayAuthMode(draft.next);
  if (mode !== "token" && mode !== "password") {
    return null;
  }
  const secret = draft.next[mode];
  if (typeof secret !== "string" || secret === REDACTED_SENTINEL || secret.trim() === "") {
    return null;
  }
  if (gatewayAuthMode(draft.base) === mode && draft.base[mode] === secret) {
    return null;
  }
  return mode === "token" ? { token: secret } : { password: secret };
}

/**
 * Owns the staged Gateway auth for one config page. Nothing here is persisted:
 * secrets live only in this draft until Apply sends them with the mode.
 */
export function createGatewayAuthDraft(options: {
  /** gateway.auth as currently saved (redacted). */
  readCurrent: () => AuthRecord;
  /** Sends one gateway.auth patch; resolves false when the write was not accepted. */
  apply: (patch: { patch: AuthRecord; replacePaths: string[] }) => Promise<boolean>;
  failureMessage: () => string;
  /** Hands a typed credential to the Gateway connection so the browser stays signed in. */
  reconnect: (credential: BrowserCredential) => void;
}) {
  const [draft, setDraft] = createSignal<GatewayAuthDraft | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const stage = (path: ConfigPath, edit: { value: unknown } | "remove") => {
    const current = draft() ?? { base: options.readCurrent(), next: options.readCurrent() };
    const staged = stageGatewayAuthEdit(current, path, edit);
    // Editing back to the saved values leaves nothing to apply.
    setDraft(Object.keys(gatewayAuthPatch(staged).patch).length > 0 ? staged : null);
    setError(null);
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  const apply = async (config: unknown): Promise<boolean> => {
    const staged = draft();
    if (!staged || applying() || gatewayAuthIssue(staged, config) !== null) {
      return false;
    }
    const credential = browserCredentialAfterApply(staged);
    setApplying(true);
    setError(null);
    try {
      let applied = false;
      try {
        applied = await options.apply(gatewayAuthPatch(staged));
      } catch {
        applied = false;
      }
      if (!applied) {
        setError(options.failureMessage());
        return false;
      }
      if (draft() === staged) {
        setDraft(null);
      }
      if (credential) {
        options.reconnect(credential);
      }
      return true;
    } finally {
      setApplying(false);
    }
  };
  return { draft, applying, error, stage, cancel, apply };
}

type FormBinding = {
  formValue: Record<string, unknown> | null;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onFormRemove: (path: Array<string | number>) => void;
};

/**
 * The config page's Gateway auth owner. Generic-form edits under gateway.auth
 * are staged here instead of reaching the autosaved draft; every other edit
 * keeps its normal path.
 */
export function createConfigGatewayAuth(
  context: Pick<ApplicationContext, "runtimeConfig" | "gateway">,
) {
  const controller = createGatewayAuthDraft({
    readCurrent: () => readGatewayAuth(context.runtimeConfig.state.configForm),
    apply: ({ patch, replacePaths }) =>
      context.runtimeConfig.patchFromSnapshot(() => ({
        options: {
          raw: { gateway: { auth: patch } },
          note: "Gateway authentication updated from Settings.",
          ...(replacePaths.length > 0 ? { replacePaths } : {}),
        },
      })),
    failureMessage: () =>
      context.runtimeConfig.state.lastError ?? t("configPage.gatewayAuth.applyFailed"),
    // The login gate's credential path: kept in memory, never in the URL or drafts.
    reconnect: (credential) => context.gateway.connect(credential),
  });
  return {
    ...controller,
    bindForm<T extends FormBinding>(config: T): T {
      return {
        ...config,
        formValue: withGatewayAuthDraft(config.formValue, controller.draft()),
        onFormPatch: (path, value) =>
          isGatewayAuthPath(path)
            ? controller.stage(path, { value })
            : config.onFormPatch(path, value),
        onFormRemove: (path) =>
          isGatewayAuthPath(path) ? controller.stage(path, "remove") : config.onFormRemove(path),
      };
    },
    /** What the Authentication card renders for the saved config form. */
    card(configForm: unknown) {
      const draft = controller.draft();
      return {
        current: readGatewayAuth(configForm),
        staged: draft?.next ?? null,
        issue: draft ? gatewayAuthIssue(draft, configForm) : null,
        applying: controller.applying(),
        error: controller.error(),
        onCancel: controller.cancel,
        onApply: () => void controller.apply(configForm),
      };
    },
  };
}

export type GatewayAuthCard = ReturnType<ReturnType<typeof createConfigGatewayAuth>["card"]>;
