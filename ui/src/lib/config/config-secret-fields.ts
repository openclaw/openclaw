import { registerListener } from "../../../../src/shared/listeners.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { t } from "../../i18n/index.ts";
import { listen } from "../reactive/listener.ts";
import { showToast } from "../toast.ts";
import type { ConfigPatchAck } from "./config-draft-model.ts";
import { buildSecretFieldPatch } from "./config-secret-field-patch.ts";
import { resolveEditableSnapshotConfig } from "./config-state-model.ts";

type ConfigPath = Array<string | number>;

const fieldKey = (path: ConfigPath) => JSON.stringify(path);

export type ConfigSecretFields = {
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
    { label: string; text: string; routeId: string; pathname: string; search: string }
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
  const syncScope = () => {
    if (entries.size > 0 && scope !== currentScope()) {
      entries.clear();
      notify();
    }
  };
  const noteLeft = (pathname: string) => {
    const left = [...entries.values()].find((entry) => entry.pathname !== pathname);
    if (left) {
      showToast({
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
    runtime.subscribe(syncScope);
    let pathname = context.router.getState().location.pathname;
    context.router.subscribe((state) => {
      if (state.location.pathname !== pathname) {
        pathname = state.location.pathname;
        noteLeft(pathname);
      }
    });
  };
  const write = (path: ConfigPath, value: unknown) =>
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
        canDispatch: () => scope === undefined || scope === currentScope(),
        configWriteAck: (ack) => ack,
      },
    );
  return {
    read(path) {
      syncScope();
      return entries.get(fieldKey(path))?.text;
    },
    hold(path, text, label) {
      wire();
      syncScope();
      scope = currentScope();
      const { location, matches } = context.router.getState();
      entries.set(fieldKey(path), {
        label,
        text,
        routeId: String(matches[0]?.routeId ?? ""),
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
      let result = await write(path, value);
      if (!result.ok && result.reason === "conflict") {
        // Only this field goes out, so the latest saved config can safely take it.
        await runtime.refresh({ background: true });
        result = await write(path, value);
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
