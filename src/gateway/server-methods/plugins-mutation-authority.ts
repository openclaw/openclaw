import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandler } from "./types.js";

type Request = Parameters<GatewayRequestHandler>[0];

/** Connection loss is not revocation; the source owner decides current write authority. */
export function assertPluginMutationAuthority({
  client,
  hasCurrentClientAuthority,
}: Pick<Request, "client" | "hasCurrentClientAuthority">): void {
  if (
    hasCurrentClientAuthority?.() === false ||
    (client &&
      (client.invalidated ||
        (client.connect.role ?? "operator") !== "operator" ||
        !client.connect.scopes?.includes(ADMIN_SCOPE)))
  ) {
    throw new Error("Plugin mutation authority is no longer active.");
  }
}
