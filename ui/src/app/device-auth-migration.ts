import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { peekStoredDeviceIdentityId } from "../lib/nodes/index.ts";
import type { ApplicationGateway } from "./gateway.ts";

type DeviceAuthMigrationSnapshot = {
  deviceAuthMigrationRequestId: string | null;
  deviceAuthMigrationBusy: boolean;
  deviceAuthMigrationError: string | null;
};

const EMPTY_SNAPSHOT: DeviceAuthMigrationSnapshot = {
  deviceAuthMigrationRequestId: null,
  deviceAuthMigrationBusy: false,
  deviceAuthMigrationError: null,
};

export function createDeviceAuthMigrationController(params: {
  gateway: ApplicationGateway;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  onChange: (snapshot: DeviceAuthMigrationSnapshot) => void;
}) {
  let snapshot = EMPTY_SNAPSHOT;
  let generation = 0;
  let disposed = false;

  const update = (patch: Partial<DeviceAuthMigrationSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    params.onChange(snapshot);
  };

  return {
    get snapshot(): DeviceAuthMigrationSnapshot {
      return snapshot;
    },
    reset() {
      generation += 1;
      update(EMPTY_SNAPSHOT);
    },
    async refresh(client: GatewayBrowserClient, epoch: number) {
      const migrationPending = params.gateway.snapshot.hello?.deviceAuthMigration?.pending === true;
      const deviceId = peekStoredDeviceIdentityId();
      if (!migrationPending || !params.isCurrent(client, epoch)) {
        generation += 1;
        update(EMPTY_SNAPSHOT);
        return;
      }
      if (!deviceId) {
        generation += 1;
        update({
          ...EMPTY_SNAPSHOT,
          deviceAuthMigrationError: t("login.deviceAuthMigration.secureContextRequired"),
        });
        return;
      }
      const refreshGeneration = ++generation;
      try {
        const result = await client.request<{
          pending?: Array<{ requestId?: unknown; deviceId?: unknown }>;
        }>("device.pair.list", {});
        if (disposed || refreshGeneration !== generation || !params.isCurrent(client, epoch)) {
          return;
        }
        const ownRequest = result.pending?.find(
          (entry) => entry.deviceId === deviceId && typeof entry.requestId === "string",
        );
        update({
          deviceAuthMigrationRequestId:
            typeof ownRequest?.requestId === "string" ? ownRequest.requestId : null,
          deviceAuthMigrationError: ownRequest
            ? null
            : t("login.deviceAuthMigration.pendingUnavailable"),
        });
      } catch (error) {
        if (refreshGeneration === generation && params.isCurrent(client, epoch)) {
          const message = error instanceof Error ? error.message : String(error);
          update({
            deviceAuthMigrationError: t("login.deviceAuthMigration.loadFailed", {
              error: message,
            }),
          });
        }
      }
    },
    async secure(client: GatewayBrowserClient | null, epoch: number) {
      const requestId = snapshot.deviceAuthMigrationRequestId;
      if (
        !client ||
        !requestId ||
        !params.gateway.snapshot.connected ||
        snapshot.deviceAuthMigrationBusy ||
        disposed
      ) {
        return;
      }
      update({ deviceAuthMigrationBusy: true, deviceAuthMigrationError: null });
      try {
        await client.request("device.pair.approve", { requestId });
        if (!params.isCurrent(client, epoch)) {
          return;
        }
        update({ deviceAuthMigrationRequestId: null, deviceAuthMigrationBusy: false });
        // Reconnect once so the newly approved browser receives and stores its
        // device token; shared auth is no longer its baseline.
        params.gateway.connect();
      } catch (error) {
        if (params.isCurrent(client, epoch)) {
          const message = error instanceof Error ? error.message : String(error);
          update({
            deviceAuthMigrationBusy: false,
            deviceAuthMigrationError: t("login.deviceAuthMigration.approvalFailed", {
              error: message,
            }),
          });
        }
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
