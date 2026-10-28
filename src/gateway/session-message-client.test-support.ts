import path from "node:path";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { connectOk } from "./test-helpers.server.js";

export function sessionClientCredentialPath(storePath: string, identityName: string): string {
  return path.join(path.dirname(storePath), identityName, "client", "credentials.sqlite");
}

export async function connectSessionClient(
  ws: Parameters<typeof connectOk>[0],
  storePath: string,
  identityName: string,
  kind: "web" | "tui",
) {
  await connectOk(ws, {
    caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
    client: {
      id: kind === "web" ? GATEWAY_CLIENT_IDS.CONTROL_UI : GATEWAY_CLIENT_IDS.TUI,
      mode: kind === "web" ? GATEWAY_CLIENT_MODES.UI : GATEWAY_CLIENT_MODES.CLI,
      platform: kind === "web" ? "web" : "test",
      version: "test",
    },
    deviceIdentityPath: sessionClientCredentialPath(storePath, identityName),
    prePairDevice: true,
    scopes: ["operator.read"],
  });
}
