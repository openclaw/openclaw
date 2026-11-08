import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { readOfflineStorageScope } from "./boot-record.ts";
import { resolveControlUiReadAuthCandidates } from "./control-ui-auth.ts";
import type { ApplicationGatewayConnection } from "./gateway.ts";

export function updateGatewayAvatarContext(
  client: GatewayBrowserClient | null,
  connection: ApplicationGatewayConnection,
  resourceBasePath: string | undefined,
  hello: GatewayHelloOk | undefined,
  isCurrent: (client: GatewayBrowserClient | null, hello: GatewayHelloOk | null) => boolean,
): void {
  setAvatarGatewayOrigin(
    connection.gatewayUrl,
    resolveControlUiReadAuthCandidates(
      { hello, settings: connection, password: connection.password },
      connection.gatewayUrl,
    ),
    resourceBasePath,
    readOfflineStorageScope({ client }),
    () => Boolean(hello) && isCurrent(client, hello ?? null),
  );
}
