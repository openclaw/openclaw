// Source-backed real Gateway: no HTTP/auth/pairing owner is mocked. This avoids
// requiring cross-platform worker-distribution downloads for a loopback auth proof.
import { startGatewayServer } from "../../../src/gateway/server.ts";

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
if (portIndex < 0 || !Number.isInteger(port) || port < 1) {
  throw new Error("Browser pairing Gateway fixture requires --port");
}
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: true });
await server.startupReady;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close({ reason: "browser pairing proof complete" });
  });
}
