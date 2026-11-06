import { createMemo, Errored, isPending, latest, Loading, type Accessor } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import {
  RetryAction,
  SettingsLoadingSkeleton,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import type { DevicesPageDataState } from "../../lib/nodes/page-operations.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { DeviceInventoryContent } from "./view-inventory.tsx";
import type { DevicesProps } from "./view.types.ts";

export function DeviceInventory(props: DevicesProps) {
  const scope = createMemo(() => props.inventoryScope);
  return (
    <Errored
      fallback={(error, reset) => (
        <>
          <div class="callout danger" role="alert">
            {formatUiError(error())}{" "}
            <RetryAction
              onRetry={() => {
                props.onReloadInventory();
                reset();
              }}
            />
          </div>
          <DeviceInventoryContent {...props} pending={false} />
        </>
      )}
    >
      <Loading
        on={latest(scope)}
        fallback={
          <SettingsSection title={t("devices.inventory.title")}>
            <SettingsLoadingSkeleton />
          </SettingsSection>
        }
      >
        {(latest(() => props.inventoryRead()), null)}
        <DeviceInventoryContent {...props} pending={isPending(() => props.inventoryRead())} />
      </Loading>
    </Errored>
  );
}

export type InventoryReadReceipt = {
  gateway: ApplicationContext["gateway"];
  state: DevicesPageDataState;
  epoch: number;
  result: Promise<void>;
};

export function createDeviceInventoryRead(options: {
  scope: Accessor<Omit<InventoryReadReceipt, "result">>;
  nodesRead: Accessor<InventoryReadReceipt | null>;
  devicesRead: Accessor<InventoryReadReceipt | null>;
}) {
  const scope = createMemo(options.scope, {
    equals: (a, b) => a.gateway === b.gateway && a.state === b.state && a.epoch === b.epoch,
  });
  const read = createMemo(() => {
    const current = scope();
    const receipts = [options.nodesRead(), options.devicesRead()].filter(
      (receipt): receipt is InventoryReadReceipt =>
        receipt?.gateway === current.gateway &&
        receipt.state === current.state &&
        receipt.epoch === current.epoch,
    );
    // The route has already awaited its snapshot; only admitted reads suspend.
    return receipts.length
      ? Promise.all(receipts.map((receipt) => receipt.result)).then(() => undefined)
      : undefined;
  });
  return { scope, read };
}
