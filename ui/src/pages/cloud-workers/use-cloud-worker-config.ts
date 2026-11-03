import { createSignal } from "solid-js";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";

/** One autosaving config owner: writes queue in the runtime config, so fields stay usable. */
export function useCloudWorkerConfig(reset: () => void, onReconnected?: () => void) {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const save = new CloudWorkerConfigSave(() => setRevision((value) => value + 1));
  let disconnected = false;
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: reset,
    onSnapshot: ({ snapshot }) => {
      const connected = snapshot.phase === "connected";
      if (connected && !canCallGatewayMethod(snapshot, "config.patch", "operator.admin")) {
        reset();
      }
      if (connected && disconnected) {
        // The write that the connection interrupted may not have landed.
        queueMicrotask(() => onReconnected?.());
      }
      disconnected = !connected;
    },
    invalidateRequests: () => save.update({ busy: false, error: null }),
  });
  const state = () => {
    revision();
    return save.state;
  };
  const hasAccess = () => canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin");
  const writable = () => hasAccess() && Boolean(runtime.read().state.configSnapshot?.hash);
  return {
    state,
    writable,
    /** Connected without write access: show values instead of disabled fields. */
    readOnly: () => gateway.connected && !hasAccess(),
    ensureLoaded: () => context.runtimeConfig.ensureLoaded(),
    config: () => resolveEditableSnapshotConfig(runtime.read().state.configSnapshot),
    update: (patch: Parameters<CloudWorkerConfigSave["update"]>[0]) => save.update(patch),
    async save(options: Omit<Parameters<CloudWorkerConfigSave["save"]>[2], "canDispatch">) {
      const scope = gateway.capture();
      const runtimeConfig = context.runtimeConfig;
      if (!scope || !writable()) {
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
