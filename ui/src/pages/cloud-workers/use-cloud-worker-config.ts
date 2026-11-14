import { action, createMemo, createOptimistic, createSignal } from "solid-js";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";

export function useCloudWorkerConfig(reset: () => void) {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const save = new CloudWorkerConfigSave(() => setRevision((value) => value + 1));
  let lifetime = Promise.withResolvers<void>();
  function retirePresentation() {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: reset,
    onSnapshot: ({ snapshot }) => {
      if (
        snapshot.phase === "connected" &&
        !canCallGatewayMethod(snapshot, "config.patch", "operator.admin")
      ) {
        retirePresentation();
        reset();
      }
    },
    invalidateRequests: () => {
      retirePresentation();
      save.update({ busy: false, error: null, notice: null });
    },
  });
  const state = () => {
    revision();
    return save.state;
  };
  const presentationLifetime = createMemo(() => {
    revision();
    // Capability changes retire presentation even without a transport epoch change.
    void gateway.snapshot;
    return lifetime;
  });
  const presentation = createMemo(() => {
    const retired = presentationLifetime().promise;
    const [saving, setSaving] = createOptimistic(false);
    return { retired, saving, setSaving };
  });
  const busy = () => presentation().saving() || state().busy;
  const presentSave = action(function* (
    current: ReturnType<typeof presentation>,
    pending: Promise<boolean>,
  ): Generator<Promise<boolean>, boolean, boolean> {
    if (current.retired === lifetime.promise) {
      current.setSaving(true);
    }
    return yield Promise.race([pending, current.retired.then(() => false)]);
  });
  const editable = () =>
    canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin") &&
    Boolean(runtime.read().state.configSnapshot?.hash) &&
    !runtime.read().state.configSaving &&
    !busy();
  return {
    state,
    busy,
    editable,
    loading: () => runtime.read().state.configLoading,
    ensureLoaded: () => context.runtimeConfig.ensureLoaded(),
    config: () => resolveEditableSnapshotConfig(runtime.read().state.configSnapshot),
    update: (patch: Parameters<CloudWorkerConfigSave["update"]>[0]) => save.update(patch),
    async save(options: Omit<Parameters<CloudWorkerConfigSave["save"]>[2], "canDispatch">) {
      const scope = gateway.capture();
      const runtimeConfig = context.runtimeConfig;
      if (!scope || !editable()) {
        return false;
      }
      const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
      const current = presentation();
      const pending = save.save(runtimeConfig, isCurrent, {
        ...options,
        canDispatch: () =>
          isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
      });
      // Keep synchronous write admission ahead of its optimistic presentation.
      await Promise.resolve();
      return presentSave(current, pending);
    },
  };
}
