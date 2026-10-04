import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { loadCurrentDeviceAuthToken } from "../lib/nodes/index.ts";
import {
  bootRecordOwner,
  clearBootRecords,
  readBootRecord,
  resolveBootRecordAuth,
  sameBootRecordOwner,
  type BootRecordOwner,
} from "./boot-record.ts";
import { clearWarmBootState } from "./bootstrap-warm-boot.ts";
import type { ApplicationGatewayConnection } from "./gateway.ts";

type GatewayCredentials = Pick<
  GatewayBrowserClientOptions,
  "offlineRecoveryScope" | "url" | "token" | "bootstrapToken" | "bootstrapProfile" | "password"
>;

/** Credential admission owns both the read boot record and its successor hello. */
export function createGatewayCredentials(ownsWarmBoot: boolean) {
  let scope: string | undefined;
  let capturedOwner: BootRecordOwner | undefined;
  let liveOwner: BootRecordOwner | undefined;
  return {
    prepare(
      connection: ApplicationGatewayConnection,
      credentialsChanged: boolean,
      previousClient: Pick<GatewayBrowserClient, "offlineRecoveryScope"> | null,
    ): GatewayCredentials {
      scope = gatewayCredentialScope(connection.gatewayUrl);
      const boot =
        ownsWarmBoot && !credentialsChanged && !connection.bootstrapToken && !connection.password
          ? readBootRecord(scope, (method) =>
              method === "token"
                ? connection.token
                : connection.token.trim()
                  ? null
                  : method === "device-token"
                    ? loadCurrentDeviceAuthToken(connection.gatewayUrl)
                    : "",
            )
          : null;
      if (boot) {
        capturedOwner = bootRecordOwner(boot);
      }
      return {
        offlineRecoveryScope:
          ownsWarmBoot && !credentialsChanged
            ? (previousClient?.offlineRecoveryScope ?? boot?.recoveryScope)
            : undefined,
        url: connection.gatewayUrl,
        token: connection.token.trim() ? connection.token : undefined,
        bootstrapToken: connection.bootstrapToken.trim() ? connection.bootstrapToken : undefined,
        bootstrapProfile: connection.bootstrapProfile,
        password: connection.password.trim() ? connection.password : undefined,
      };
    },
    acceptHello(auth: GatewayHelloOk["auth"], token: string): void {
      if (!ownsWarmBoot) {
        return;
      }
      const credentials = resolveBootRecordAuth(auth, token);
      // A hello does not mean persistence replaced the captured record yet. Keep
      // that exact owner through rejection/credential edits, especially v2 records
      // whose credential fingerprint predates the server recovery scope.
      liveOwner = auth?.recoveryScope
        ? { recoveryScope: auth.recoveryScope }
        : credentials
          ? bootRecordOwner(credentials)
          : undefined;
    },
    retire(clearCaches: boolean): void {
      const gatewayScope = scope;
      const owners = capturedOwner ? [capturedOwner] : [];
      if (liveOwner && !sameBootRecordOwner(capturedOwner, liveOwner)) {
        owners.push(liveOwner);
      }
      // Retirement observers may synchronously start a replacement connection.
      capturedOwner = undefined;
      liveOwner = undefined;
      if (!gatewayScope) {
        return;
      }
      for (const owner of owners) {
        if (clearCaches) {
          void clearWarmBootState(gatewayScope, owner);
        } else {
          clearBootRecords(gatewayScope, owner);
        }
      }
    },
  };
}
