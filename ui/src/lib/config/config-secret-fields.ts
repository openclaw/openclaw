import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSecretRefShape } from "../../../../src/config/redact-snapshot.secret-ref.js";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { t } from "../../i18n/index.ts";
import { REDACTED_SENTINEL } from "../config-form-utils.ts";
import { listen } from "../reactive/listener.ts";
import { showToast } from "../toast.ts";
import type { ConfigPatchAck } from "./config-draft-model.ts";
import { buildSecretFieldPatch, secretRowMatchesSavedList } from "./config-secret-field-patch.ts";
import { resolveEditableSnapshotConfig } from "./config-state-model.ts";
import { storedSecretSource, type StoredSecretSource } from "./stored-secret-source.ts";

type ConfigPath = Array<string | number>;

const fieldKey = (path: ConfigPath) => JSON.stringify(path);

const MISSING = Symbol("missing");

/** The saved value at a path, or MISSING when the snapshot can't say. */
function savedValue(snapshot: ConfigSnapshot | null | undefined, path: ConfigPath): unknown {
  let node: unknown = resolveEditableSnapshotConfig(snapshot);
  if (node === null) {
    return MISSING;
  }
  for (const segment of path) {
    // A SecretRef's parts are a reference too; none of them is a value to type over.
    if (isRecord(node) && isSecretRefShape(node)) {
      return REDACTED_SENTINEL;
    }
    node =
      isRecord(node) || Array.isArray(node)
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  return isRecord(node) && isSecretRefShape(node) ? REDACTED_SENTINEL : node;
}

/**
 * Whether a held edit may still go out. Only a stored secret proven to be plain text in the file is
 * written over. A reference, or a ${VAR} the field wasn't showing when typing began, can arrive
 * from elsewhere while the edit is held; Save never writes over either. Undefined means the
 * snapshot can't tell yet, and the edit waits.
 */
function canWriteOver(
  snapshot: ConfigSnapshot | null | undefined,
  path: ConfigPath,
  baseline: unknown,
): boolean | undefined {
  const saved = savedValue(snapshot, path);
  if (saved === MISSING) {
    return undefined;
  }
  if (saved === REDACTED_SENTINEL) {
    return storedSecretSource(snapshot, path).kind === "literal";
  }
  return !(typeof saved === "string" && saved.includes("${") && saved !== baseline);
}

/** What a form may do with the stored secret at a path. */
export type StoredSecretSources = {
  source: (path: ConfigPath) => StoredSecretSource;
};

export type ConfigSecretFields = StoredSecretSources & {
  read: (path: ConfigPath) => string | undefined;
  hold: (path: ConfigPath, text: string, label: string) => void;
  release: (path: ConfigPath) => void;
  save: (path: ConfigPath, value: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;
  subscribe: (listener: () => void) => () => void;
};

type SecretFieldsContext = Pick<
  ApplicationContext,
  "runtimeConfig" | "gateway" | "router" | "navigate"
>;

/**
 * Unsaved secret fields stay here, outside the config draft, so no autosave can carry them.
 * They survive the field unmounting, and a field Save is the only way they reach the Gateway.
 */
function createConfigSecretFields(context: SecretFieldsContext): ConfigSecretFields {
  const runtime = context.runtimeConfig;
  const entries = new Map<
    string,
    {
      path: ConfigPath;
      /** The saved value the field showed when typing began. */
      baseline: unknown;
      label: string;
      text: string;
      routeId: string;
      pathname: string;
      search: string;
    }
  >();
  const listeners = new Set<() => void>();
  let scope: number | undefined;
  let wired = false;
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const currentScope = () => gatewayPresentationScope(context.gateway).key;
  // A different Gateway never inherits a secret typed for the previous one.
  // The edit is dropped, never carried over, and the person is told which field lost it.
  const syncScope = () => {
    if (entries.size > 0 && scope !== currentScope()) {
      const dropped = [...entries.values()];
      entries.clear();
      notify();
      for (const entry of dropped) {
        showToast({
          severity: "error",
          message: t("configForm.secretDroppedOnConnectionChange", { field: entry.label }),
          durationMs: 12_000,
        });
      }
    }
  };
  // A stored secret's source can change with the saved config, so fields re-read it.
  let seenSnapshot = runtime.state.configSnapshot;
  runtime.subscribe(() => {
    if (runtime.state.configSnapshot !== seenSnapshot) {
      seenSnapshot = runtime.state.configSnapshot;
      notify();
    }
  });
  // Draft rows that moved or vanished would put the value on another saved row.
  const rowsMatch = (path: ConfigPath) => {
    const base = resolveEditableSnapshotConfig(runtime.state.configSnapshot);
    return !base || secretRowMatchesSavedList({ base, draft: runtime.state.configForm, path });
  };
  const writable = (path: ConfigPath) =>
    canWriteOver(runtime.state.configSnapshot, path, entries.get(fieldKey(path))?.baseline);
  // An edit over something that turned into a reference is dropped, so the field shows that instead.
  const dropUnwritable = () => {
    let dropped = false;
    for (const [key, entry] of entries) {
      if (writable(entry.path) === false) {
        entries.delete(key);
        dropped = true;
      }
    }
    if (dropped) {
      notify();
    }
  };
  const noteLeft = (pathname: string) => {
    const left = [...entries.values()].find((entry) => entry.pathname !== pathname);
    if (left) {
      showToast({
        severity: undefined,
        actionPrimary: true,
        message: t("configForm.secretUnsavedOnLeave", { field: left.label }),
        actionLabel: t("configForm.secretReview"),
        onAction: () =>
          // SAFETY: The route id was read from the router's own match for this location.
          context.navigate(left.routeId as Parameters<SecretFieldsContext["navigate"]>[0], {
            pathname: left.pathname,
            search: left.search,
          }),
        durationMs: 12_000,
      });
    }
  };
  const wire = () => {
    if (wired) {
      return;
    }
    wired = true;
    listen(window, "beforeunload", (event) => {
      if (entries.size > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    runtime.subscribe(() => {
      syncScope();
      dropUnwritable();
    });
    let pathname = context.router.getState().location.pathname;
    context.router.subscribe((state) => {
      if (state.location.pathname !== pathname) {
        pathname = state.location.pathname;
        noteLeft(pathname);
      }
    });
  };
  const write = (path: ConfigPath, value: unknown, saveScope: number) =>
    runtime.runExternalMutation<ConfigPatchAck>(
      (client) => {
        const snapshot = runtime.state.configSnapshot;
        const base = resolveEditableSnapshotConfig(snapshot);
        if (!base || !snapshot?.hash) {
          throw new Error("Configuration is unavailable; refresh and try again.");
        }
        const { patch, replacePaths } = buildSecretFieldPatch({
          base,
          draft: runtime.state.configForm,
          path,
          value,
        });
        return client.request<ConfigPatchAck>("config.patch", {
          baseHash: snapshot.hash,
          raw: JSON.stringify(patch),
          sessionKey: runtime.state.applySessionKey,
          note: `settings: update ${path.map(String).join(".")}`,
          ...(replacePaths.length > 0 ? { replacePaths } : {}),
        });
      },
      {
        // Checked against the snapshot the patch is built from, right before it goes out.
        canDispatch: () =>
          saveScope === currentScope() && writable(path) !== false && rowsMatch(path),
        configWriteAck: (ack) => ack,
      },
    );
  const refuse = (path: ConfigPath) => {
    dropUnwritable();
    if (entries.delete(fieldKey(path))) {
      notify();
    }
    // The field now shows what's saved there, which says why nothing was written.
    return { ok: false as const, error: "" };
  };
  return {
    source: (path) => storedSecretSource(runtime.state.configSnapshot, path),
    read(path) {
      syncScope();
      return entries.get(fieldKey(path))?.text;
    },
    hold(path, text, label) {
      wire();
      syncScope();
      scope = currentScope();
      const key = fieldKey(path);
      const held = entries.get(key);
      const { location, matches } = context.router.getState();
      entries.set(key, {
        path: [...path],
        baseline: held ? held.baseline : savedValue(runtime.state.configSnapshot, path),
        label,
        text,
        routeId: matches[0]?.routeId ?? "",
        pathname: location.pathname,
        search: location.search,
      });
      notify();
    },
    release(path) {
      if (entries.delete(fieldKey(path))) {
        notify();
      }
    },
    async save(path, value) {
      syncScope();
      const saveScope = currentScope();
      if (writable(path) === false) {
        return refuse(path);
      }
      if (!rowsMatch(path)) {
        return { ok: false, error: t("configForm.draftRejected") };
      }
      let result = await write(path, value, saveScope);
      if (!result.ok && result.reason === "conflict" && saveScope === currentScope()) {
        // Only this field goes out, so the latest saved config can safely take it.
        await runtime.refresh({ background: true });
        if (saveScope !== currentScope()) {
          return { ok: false, error: "" };
        }
        result = writable(path) === false ? result : await write(path, value, saveScope);
      }
      if (saveScope !== currentScope()) {
        return { ok: false, error: "" };
      }
      if (!result.ok && writable(path) === false) {
        return refuse(path);
      }
      if (!result.ok && !rowsMatch(path)) {
        return { ok: false, error: t("configForm.draftRejected") };
      }
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    subscribe: (listener) => registerListener(listeners, listener),
  };
}

const owners = new WeakMap<object, ConfigSecretFields>();

export function configSecretFields(context: SecretFieldsContext): ConfigSecretFields {
  let owner = owners.get(context.runtimeConfig);
  if (!owner) {
    owner = createConfigSecretFields(context);
    owners.set(context.runtimeConfig, owner);
  }
  return owner;
}
