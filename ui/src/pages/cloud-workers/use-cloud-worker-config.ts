import { createSignal } from "solid-js";
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
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => {
      reset();
      save.update({ busy: false, error: null, notice: null });
    },
  });
  const state = () => {
    revision();
    return save.state;
  };
  const editable = () =>
    canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin") &&
    Boolean(runtime.read().state.configSnapshot?.hash) &&
    !runtime.read().state.configSaving &&
    !state().busy;
  return {
    state,
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
      return save.save(runtimeConfig, isCurrent, {
        ...options,
        canDispatch: () =>
          isCurrent() && canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin"),
      });
    },
  };
}
