// Tunnel child process entry (forked by the Gateway's tunnel supervisor).
// Owns the iroh endpoint key; the Gateway never reads it. Talks to the
// Gateway over IPC for control and over the ingress socket for data. Logs
// carry `fp:` labels only, never key material.
import {
  TUNNEL_EXIT_KEY_REFUSED,
  TUNNEL_EXIT_UNAVAILABLE,
  type GatewayToTunnelMessage,
  type TunnelStartMessage,
  type TunnelToGatewayMessage,
} from "../tunnel-ipc.js";
import { loadIrohBinding, type IrohBinding, type IrohEndpoint } from "./addon.js";
import { KeyFileRefusedError, loadOrCreateEndpointKey, logFingerprint } from "./keyfile.js";
import { nextRelayState, type RelayState } from "./relay-state.js";
import { IngressServer, TUNNEL_ALPN_BYTES } from "./server.js";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function send(message: TunnelToGatewayMessage): void {
  process.send?.(message);
}

// What this child owns. stop() closes it so Node exits on its own.
const owned: { endpoint?: IrohEndpoint; server?: IngressServer; stopping: boolean } = {
  stopping: false,
};

// Ends the child without forcing termination (nodejs/node#64274): records the exit
// status, closes the endpoint and its connections, then releases the IPC channel, whose
// message and disconnect listeners are the last things keeping the event loop alive.
async function stop(code: number): Promise<void> {
  if (owned.stopping) {
    return;
  }
  owned.stopping = true;
  process.exitCode = code;
  try {
    await (owned.server ? owned.server.shutdown() : owned.endpoint?.close());
  } finally {
    process.removeAllListeners("message");
    process.removeAllListeners("disconnect");
    if (process.connected) {
      process.disconnect?.();
    }
  }
}

// Binds the endpoint, announces ready and serves until the endpoint closes.
async function serve(
  binding: IrohBinding,
  start: TunnelStartMessage,
  takeOver: (handle: (message: GatewayToTunnelMessage) => void) => void,
) {
  let key: Buffer;
  let created: boolean;
  try {
    ({ key, created } = loadOrCreateEndpointKey(start.keyPath));
  } catch (error) {
    // SAFETY: loadOrCreateEndpointKey throws only Error instances (fs errors and KeyFileRefusedError).
    log(`key refused: ${(error as Error).message}`);
    await stop(error instanceof KeyFileRefusedError ? TUNNEL_EXIT_KEY_REFUSED : 1);
    return;
  }
  const endpoint = await binding.bind({
    secretKey: key,
    relayUrl: start.relayUrl,
    alpns: [TUNNEL_ALPN_BYTES],
    ...(start.bindAddr ? { bindAddr: start.bindAddr } : {}),
  });
  key.fill(0);
  owned.endpoint = endpoint;
  if (owned.stopping) {
    // The Gateway left while the endpoint was binding: close it instead of serving.
    await endpoint.close();
    return;
  }
  const server = new IngressServer({
    endpoint,
    target: { socketPath: start.ingress.socketPath },
    proxyToken: start.ingress.proxyToken,
    forwardedProto: start.forwardedProto,
    log,
    onConnectionsChanged: (connections) =>
      send({ type: "state", relayOnline, connections, relayDenied }),
  });
  let relayOnline = false;
  let relayDenied: string | null = null;
  const report = () =>
    send({ type: "state", relayOnline, connections: server.connectionCount(), relayDenied });
  followHomeRelay(endpoint, ({ online, denied }) => {
    if (denied !== null && relayDenied === null) {
      log(`relay refused this endpoint: ${denied}`);
    } else if (online && !relayOnline) {
      log("relay online");
    }
    relayOnline = online;
    relayDenied = denied;
    report();
  });

  const handle = (message: GatewayToTunnelMessage) => {
    if (message.type === "membership") {
      server.setMembership(message.admitted);
    } else if (message.type === "ping") {
      send({ type: "pong", id: message.id, rssBytes: process.memoryUsage.rss() });
    }
  };
  takeOver(handle);

  owned.server = server;
  // SIGTERM/SIGINT close connections with `shutdown` and the endpoint, then exit 0.
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
  const endpointId = endpoint.id();
  log(`iroh tunnel up: server=${logFingerprint(endpointId)} key=${created ? "created" : "loaded"}`);
  send({
    type: "ready",
    endpointKey: `iroh:${endpointId}`,
    relayUrl: start.relayUrl,
    directAddrs: endpoint.boundSockets(),
    keyCreated: created,
  });
  await server.run();
}

// Reports relay attachment and relay-side admission denials as they change.
// The watcher ends when the endpoint closes.
function followHomeRelay(endpoint: IrohEndpoint, onChange: (state: RelayState) => void): void {
  void endpoint.watchHomeRelay().then(async (watcher) => {
    let state: RelayState = { online: false, denied: null };
    for (let list = await watcher.next(); list; list = await watcher.next()) {
      const next = nextRelayState(state, list);
      if (next.online !== state.online || next.denied !== state.denied) {
        state = next;
        onChange(state);
      }
    }
  });
}

function main(): void {
  let binding: IrohBinding;
  try {
    binding = loadIrohBinding();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    // Nothing is open yet, so setting the status lets the child exit.
    process.exitCode = TUNNEL_EXIT_UNAVAILABLE;
    return;
  }
  // A lost IPC channel means the Gateway died: stop so no orphan holds the key and socket.
  process.on("disconnect", () => void stop(0));
  // Messages that arrive before the server is up are replayed to it in order.
  const pending: GatewayToTunnelMessage[] = [];
  let handler: ((message: GatewayToTunnelMessage) => void) | undefined;
  let started = false;
  const takeOver = (handle: (message: GatewayToTunnelMessage) => void) => {
    handler = handle;
    pending.splice(0).forEach(handle);
  };
  process.on("message", (message: GatewayToTunnelMessage) => {
    if (handler) {
      handler(message);
      return;
    }
    if (message.type !== "start" || started) {
      pending.push(message);
      return;
    }
    started = true;
    serve(binding, message, takeOver).catch((error: unknown) => {
      log(`fatal: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      void stop(1);
    });
  });
}

main();
