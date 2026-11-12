import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { REDACTED_SENTINEL, removePathValue, setPathValue } from "../../lib/config-form-utils.ts";
import type { ConfigPatchAck } from "../../lib/config/config-draft-model.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";

// Gateway auth edits stay out of the shared config draft: autosave writes the
// whole draft, so a half-made mode change would otherwise lock the browser out.
// They are staged here, bound to the Gateway they were made for, and the
// Authentication card applies mode and credentials together as one
// base-hash-checked config.patch.

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
 * The saved secret this browser is asked for after the staged mode change applies.
 * The page cannot hand over a secret it only knows as saved.
 */
export function signInAgainWith(draft: GatewayAuthDraft): "token" | "password" | null {
  const mode = gatewayAuthMode(draft.next);
  return (mode === "token" || mode === "password") &&
    mode !== gatewayAuthMode(draft.base) &&
    hasCredential(draft.next[mode]) &&
    !browserCredentialAfterApply(draft)
    ? mode
    : null;
}

type GatewayAuthApplyResult =
  | { ok: true }
  /** `stale`: the saved auth no longer matches what the staged edit started from. */
  | { ok: false; error: string; stale?: boolean };

/**
 * Owns the staged Gateway auth. Nothing here is persisted: secrets live only in
 * this draft until Apply sends them with the mode.
 */
export function createGatewayAuthDraft(options: {
  /** gateway.auth as currently saved (redacted). */
  readCurrent: () => AuthRecord;
  /** Identifies the Gateway and sign-in the page shows; a staged edit never leaves it. */
  scope: () => number;
  /** Sends the staged edit as one gateway.auth patch. */
  apply: (draft: GatewayAuthDraft) => Promise<GatewayAuthApplyResult>;
  /** Hands a typed credential to the Gateway connection so the browser stays signed in. */
  reconnect: (credential: BrowserCredential) => void;
  /** Says that the staged edit was dropped with the connection it belonged to. */
  onConnectionChanged: () => void;
}) {
  // Plain state decides; the signal only tells views to read it again. Connection
  // changes arrive synchronously, before a signal write would be readable.
  const state: {
    draft: GatewayAuthDraft | null;
    scope: number | undefined;
    applying: boolean;
    error: string | null;
  } = { draft: null, scope: undefined, applying: false, error: null };
  const [revision, setRevision] = createSignal(0);
  const update = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    setRevision((value) => value + 1);
  };
  const view = () => {
    revision();
    return state;
  };
  const owned = () => state.draft !== null && state.scope === options.scope();
  const stage = (path: ConfigPath, edit: { value: unknown } | "remove") => {
    if (state.applying) {
      // The edit being applied is settled; a late change would orphan its sign-in handoff.
      return;
    }
    const current = (owned() ? state.draft : null) ?? {
      base: options.readCurrent(),
      next: options.readCurrent(),
    };
    const staged = stageGatewayAuthEdit(current, path, edit);
    // Editing back to the saved values leaves nothing to apply.
    const draft = Object.keys(gatewayAuthPatch(staged).patch).length > 0 ? staged : null;
    update({ draft, scope: options.scope(), error: null });
  };
  const cancel = () => update({ draft: null, error: null });
  // A different Gateway or sign-in never inherits auth staged for the previous one,
  // least of all a typed secret. The edit is dropped, never carried over.
  const syncScope = () => {
    if (state.draft && !owned()) {
      cancel();
      options.onConnectionChanged();
    }
  };
  const apply = async (config: unknown): Promise<boolean> => {
    const staged = state.draft;
    if (!staged || !owned() || state.applying || gatewayAuthIssue(staged, config) !== null) {
      return false;
    }
    const credential = browserCredentialAfterApply(staged);
    update({ applying: true, error: null });
    try {
      const result = await options
        .apply(staged)
        .catch((): GatewayAuthApplyResult => ({ ok: false, error: "" }));
      if (state.draft !== staged) {
        // Dropped with its connection meanwhile; syncScope already announced it.
        return false;
      }
      if (!result.ok) {
        update(
          result.stale
            ? // Applying would overwrite auth this page never showed; start over from what is saved.
              { draft: null, error: t("configPage.gatewayAuth.changedElsewhere") }
            : { error: result.error || t("configPage.gatewayAuth.applyFailed") },
        );
        return false;
      }
      update({ draft: null });
      if (credential) {
        options.reconnect(credential);
      }
      return true;
    } finally {
      update({ applying: false });
    }
  };
  return { view, owned, stage, cancel, syncScope, apply };
}

type FormBinding = {
  formValue: Record<string, unknown> | null;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onFormRemove: (path: Array<string | number>) => void;
};

type GatewayAuthContext = Pick<ApplicationContext, "runtimeConfig" | "gateway">;

const sameAuth = (left: AuthRecord, right: AuthRecord) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Generic-form edits under gateway.auth are staged here instead of reaching the
 * autosaved draft; every other edit keeps its normal path.
 */
function createConfigGatewayAuth(context: GatewayAuthContext) {
  const runtime = context.runtimeConfig;
  const savedAuth = () =>
    readGatewayAuth(resolveEditableSnapshotConfig(runtime.state.configSnapshot));
  // An independent write like a held secret field's: it never joins the form draft, its
  // retry or its shared save status, and the patch is checked against the snapshot it
  // is sent over, right before it goes out.
  const send = (staged: GatewayAuthDraft) =>
    runtime.runExternalMutation<ConfigPatchAck>(
      (client) => {
        const snapshot = runtime.state.configSnapshot;
        if (!snapshot?.hash) {
          throw new Error("Configuration is unavailable; refresh and try again.");
        }
        const { patch, replacePaths } = gatewayAuthPatch(staged);
        return client.request<ConfigPatchAck>("config.patch", {
          baseHash: snapshot.hash,
          raw: JSON.stringify({ gateway: { auth: patch } }),
          sessionKey: runtime.state.applySessionKey,
          note: "Gateway authentication updated from Settings.",
          ...(replacePaths.length > 0 ? { replacePaths } : {}),
        });
      },
      {
        canDispatch: () => controller.owned() && sameAuth(staged.base, savedAuth()),
        dispatchError: t("configPage.gatewayAuth.changedElsewhere"),
        configWriteAck: (ack) => ack,
        // The Gateway may be restarting into the new mode; the reconnect reads it back.
        shouldRefresh: () => false,
      },
    );
  const controller = createGatewayAuthDraft({
    readCurrent: () => readGatewayAuth(runtime.state.configForm),
    scope: () => gatewayPresentationScope(context.gateway).key,
    apply: async (staged) => {
      let result = await send(staged);
      if (!result.ok && result.reason === "conflict") {
        // Only gateway.auth goes out, so an unrelated save elsewhere need not block it.
        await runtime.refresh({ background: true });
        result = await send(staged);
      }
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error, stale: !sameAuth(staged.base, savedAuth()) };
    },
    // The login gate's credential path: kept in memory, never in the URL or drafts.
    reconnect: (credential) => context.gateway.connect(credential),
    onConnectionChanged: () =>
      showToast({
        severity: "error",
        message: t("configForm.secretDroppedOnConnectionChange", {
          field: t("configPage.gatewayAuth.title"),
        }),
        durationMs: 12_000,
      }),
  });
  // The config owner publishes every connection change, for as long as it lives.
  runtime.subscribe(controller.syncScope);
  return {
    stage: controller.stage,
    bindForm<T extends FormBinding>(config: T): T {
      return {
        ...config,
        formValue: withGatewayAuthDraft(config.formValue, controller.view().draft),
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
      const { draft, applying, error } = controller.view();
      return {
        current: readGatewayAuth(configForm),
        staged: draft?.next ?? null,
        issue: draft ? gatewayAuthIssue(draft, configForm) : null,
        signInAgainWith: draft ? signInAgainWith(draft) : null,
        applying,
        error,
        onCancel: controller.cancel,
        onApply: () => void controller.apply(configForm),
      };
    },
  };
}

type ConfigGatewayAuth = ReturnType<typeof createConfigGatewayAuth>;
const owners = new WeakMap<object, ConfigGatewayAuth>();

/**
 * The staged Gateway auth for one config owner. Like held secret fields it outlives
 * the page, so leaving Settings keeps the edit staged, and visibly so, until it is
 * applied, cancelled, or the connection it belongs to changes.
 */
export function configGatewayAuth(context: GatewayAuthContext): ConfigGatewayAuth {
  let owner = owners.get(context.runtimeConfig);
  if (!owner) {
    owner = createConfigGatewayAuth(context);
    owners.set(context.runtimeConfig, owner);
  }
  return owner;
}

export type GatewayAuthCard = ReturnType<ConfigGatewayAuth["card"]>;
