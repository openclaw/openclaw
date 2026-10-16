import assert from "node:assert/strict";
import net from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const channel = parentPort;
assert(channel);
// SAFETY: The private test worker receives only its fixture connection and shared counter.
const { original, dropped } = workerData as { original: string; dropped: Int32Array };

// The main test thread may synchronously admit PostgreSQL while this proxy forwards traffic.
const destination = new URL(original);
const upstreamAddress = { host: destination.hostname, port: Number(destination.port || 5432) };
const sockets = new Set<net.Socket>();
const server = net.createServer((client) => {
  const upstream = net.createConnection(upstreamAddress);
  sockets.add(client);
  sockets.add(upstream);
  client.once("close", () => {
    sockets.delete(client);
    upstream.destroy();
  });
  upstream.once("close", () => {
    sockets.delete(upstream);
    client.destroy();
  });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  let tail = Buffer.alloc(0);
  let backend = Buffer.alloc(0);
  let commit = false;
  const query = Buffer.concat([Buffer.from([81, 0, 0, 0, 11]), Buffer.from("COMMIT\0")]);
  client.on("data", (chunk) => {
    const observed = Buffer.concat([tail, Buffer.from(chunk)]);
    commit ||= observed.includes(query);
    tail = observed.subarray(Math.max(0, observed.length - query.length));
    upstream.write(chunk);
  });
  upstream.on("data", (chunk) => {
    if (!commit) {
      client.write(chunk);
      return;
    }
    backend = Buffer.concat([backend, Buffer.from(chunk)]);
    while (backend.length >= 5) {
      const length = backend.readInt32BE(1) + 1;
      if (backend.length < length) {
        break;
      }
      const packet = backend.subarray(0, length);
      backend = backend.subarray(length);
      if (
        Atomics.load(dropped, 0) === 0 &&
        commit &&
        packet[0] === 67 &&
        packet.subarray(5).toString() === "COMMIT\0"
      ) {
        Atomics.add(dropped, 0, 1);
        client.destroy();
        upstream.destroy();
        return;
      }
      client.write(packet);
    }
  });
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
destination.hostname = "127.0.0.1";
destination.port = String(address.port);
destination.searchParams.set("sslmode", "disable");
channel.postMessage(destination.toString(), []);
channel.once("message", () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.close((error) => {
    assert.ifError(error);
    channel.close();
  });
});
