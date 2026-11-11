// Fake tunnel child for supervisor tests. FAKE_TUNNEL_MODE selects its behavior;
// FAKE_TUNNEL_MARKER (a directory) records one file per start so tests can count restarts.
import fs from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_TUNNEL_MODE ?? "ok";
if (process.env.FAKE_TUNNEL_MARKER) {
  fs.writeFileSync(path.join(process.env.FAKE_TUNNEL_MARKER, `start-${process.pid}`), mode);
}
process.on("disconnect", () => process.exit(0));
if (mode === "unavailable") {
  process.exit(78);
}
// The binding "appears" once the test creates FAKE_TUNNEL_AVAILABLE.
if (mode === "unavailable-until" && !fs.existsSync(process.env.FAKE_TUNNEL_AVAILABLE ?? "")) {
  process.exit(78);
}
if (mode === "crash") {
  process.exit(1);
}
if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => {});
}
process.on("message", (message) => {
  if (message.type === "start") {
    console.log(`fake child up relay=${message.relayUrl}`);
    process.send({
      type: "ready",
      endpointKey: "iroh:" + "ab".repeat(32),
      relayUrl: message.relayUrl,
      keyCreated: true,
    });
    process.send(
      mode === "denied"
        ? { type: "state", relayOnline: false, connections: 0, relayDenied: "not authorized" }
        : { type: "state", relayOnline: true, connections: 2 },
    );
    return;
  }
  if (message.type === "membership") {
    console.log(`membership seq=${message.seq} admitted=${message.admitted.length}`);
    return;
  }
  if (message.type === "ping" && mode !== "hang") {
    const rssBytes = mode === "rss" ? 4 * 1024 * 1024 * 1024 : process.memoryUsage.rss();
    process.send({ type: "pong", id: message.id, rssBytes });
  }
});
setInterval(() => {}, 1 << 30);
