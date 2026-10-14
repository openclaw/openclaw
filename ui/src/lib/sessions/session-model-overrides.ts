import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPatch, SessionPatchOptions } from "./patch.ts";
import type { SessionConnectionScope } from "./session-capability.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";

type Host = Pick<SessionMutationsHost, "connection" | "readState" | "publish" | "publishedRow">;

/** Own create previews and optimistic model claims until canonical rows replace them. */
export function createSessionModelOverrides(host: Host) {
  const pendingModelPatches = new Map<
    string,
    {
      token: symbol;
      previous: { value: string | null | undefined; created: boolean };
      revision: number;
    }
  >();
  const pendingCreatedModelOverrides = new Set<string>();

  const setModelOverride = (key: string, value: string | null | undefined, created = false) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    // Register before publishing: a synchronous subscriber may claim the same value.
    if (created) {
      pendingCreatedModelOverrides.add(normalizedKey);
    } else {
      pendingCreatedModelOverrides.delete(normalizedKey);
    }
    // Equal-value writes still transfer ownership while a patch is pending.
    const pendingModelPatch = pendingModelPatches.get(normalizedKey);
    if (pendingModelPatch) {
      pendingModelPatch.revision += 1;
    }
    const state = host.readState();
    const modelOverrides = { ...state.modelOverrides };
    if (value === undefined) {
      if (!Object.hasOwn(state.modelOverrides, normalizedKey)) {
        return;
      }
      delete modelOverrides[normalizedKey];
    } else {
      const normalizedValue = value === null ? null : value.trim();
      if (
        modelOverrides[normalizedKey] === normalizedValue &&
        Object.hasOwn(modelOverrides, normalizedKey)
      ) {
        return;
      }
      modelOverrides[normalizedKey] = normalizedValue;
    }
    host.publish({ ...state, modelOverrides });
  };

  const retireModelOverride = (key: string) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    pendingModelPatches.delete(normalizedKey);
    setModelOverride(normalizedKey, undefined);
  };

  const preparePatch = (
    key: string,
    patchParams: SessionPatch,
    options: SessionPatchOptions,
    scope: SessionConnectionScope,
  ) => {
    const normalizedKey = key.trim();
    const managesModelOverride = Object.hasOwn(patchParams, "model");
    const ownsModelOverride = () => options.ownsModelOverride?.() !== false;
    let modelPatchRevision = 0;
    let modelPatchToken: symbol | undefined;
    const startModelPatch = () => {
      if (!managesModelOverride || modelPatchToken || !ownsModelOverride()) {
        return;
      }
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      modelPatchToken = Symbol("session-model-patch");
      pendingModelPatches.set(normalizedKey, {
        token: modelPatchToken,
        previous: pendingModelPatch?.previous ?? {
          value: host.readState().modelOverrides[normalizedKey],
          created: pendingCreatedModelOverrides.has(normalizedKey),
        },
        revision: 0,
      });
      setModelOverride(key, patchParams.model);
      modelPatchRevision = pendingModelPatches.get(normalizedKey)?.revision ?? 0;
    };
    const settleModelOverride = (completed: boolean) => {
      if (!modelPatchToken) {
        return;
      }
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      if (pendingModelPatch?.token !== modelPatchToken) {
        return;
      }
      pendingModelPatches.delete(normalizedKey);
      // Success and rollback may settle only this operation's untouched claim.
      if (pendingModelPatch.revision !== modelPatchRevision) {
        return;
      }
      if (host.connection.isCurrent(scope) && ownsModelOverride()) {
        if (completed && !options.deferListRefresh) {
          // The canonical row carries the Gateway-confirmed selection.
          // Keeping an overlay would hide subsequent external model changes.
          setModelOverride(key, undefined);
        } else {
          const previous = pendingModelPatch.previous;
          // A failed patch restores a create preview only until its canonical row arrives.
          const created =
            !completed &&
            previous.created &&
            host.publishedRow(normalizedKey)?.modelOverrideSource === undefined;
          setModelOverride(
            key,
            completed
              ? patchParams.model
              : previous.created && !created
                ? undefined
                : previous.value,
            created,
          );
        }
      } else {
        // The shared key now belongs to another agent/connection. Remove only
        // this operation's untouched optimistic value; preserve newer claims.
        setModelOverride(key, undefined);
      }
    };
    return { start: startModelPatch, settle: settleModelOverride };
  };

  return {
    set: setModelOverride,
    retire: retireModelOverride,
    preparePatch,
    settleCreated(row: GatewaySessionRow) {
      if (row.modelOverrideSource !== undefined && pendingCreatedModelOverrides.has(row.key)) {
        setModelOverride(row.key, undefined);
      }
    },
    clear() {
      pendingCreatedModelOverrides.clear();
      pendingModelPatches.clear();
    },
  };
}
