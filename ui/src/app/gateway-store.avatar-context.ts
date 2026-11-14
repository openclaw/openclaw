import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { readOfflineStorageScope } from "./boot-record.ts";
import {
  resolveControlUiAuthCandidates,
  resolveControlUiImageAuthCandidates,
} from "./control-ui-auth.ts";
import type { ApplicationGatewayConnection } from "./gateway.ts";

export function updateGatewayAvatarContext(
  client: GatewayBrowserClient | null,
  connection: ApplicationGatewayConnection,
  resourceBasePath: string | undefined,
  hello: GatewayHelloOk | undefined,
  isCurrent: (client: GatewayBrowserClient | null, hello: GatewayHelloOk | null) => boolean,
): void {
  const auth = { hello, settings: connection, password: connection.password };
  setAvatarGatewayOrigin(
    connection.gatewayUrl,
    resolveControlUiAuthCandidates(auth),
    resourceBasePath,
    readOfflineStorageScope({ client }),
    () => Boolean(hello) && isCurrent(client, hello ?? null),
    resolveControlUiImageAuthCandidates(auth, connection.gatewayUrl),
  );
}
