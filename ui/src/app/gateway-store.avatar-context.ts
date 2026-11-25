import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { readOfflineStorageScope } from "./boot-record.ts";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";
import type { ApplicationGatewayConnection } from "./gateway.ts";

export function updateGatewayAvatarContext(
  client: GatewayBrowserClient | null,
  connection: ApplicationGatewayConnection,
  resourceBasePath: string | undefined,
  hello?: GatewayHelloOk,
): void {
  setAvatarGatewayOrigin(
    connection.gatewayUrl,
    resolveControlUiAuthCandidates({ hello, settings: connection, password: connection.password }),
    resourceBasePath,
    readOfflineStorageScope({ client }),
  );
}
