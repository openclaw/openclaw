import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { requireNodeTool } from "../../test/helpers/node-toolchain.js";
import { createDeferredCore } from "../shared/deferred.js";
import { shellEscape } from "../shared/shell-quote.js";

/** Hold a real file-transport fetch until its process owner cancels it. */
export async function createHeldGitTransport(root: string) {
  const connected = createDeferredCore();
  const sockets = new Set<Socket>();
  let receivedBytes = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", (data) => {
      receivedBytes += data.length;
      connected.resolve();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture listener address");
  }
  // Keep the real promisor fetch on file transport. Its upload-pack child
  // signals readiness over loopback, then holds Git until the owner cancels.
  const uploadPack = path.join(root, "held-upload-pack.mjs");
  await fs.writeFile(
    uploadPack,
    `import { connect } from "node:net";
const socket = connect(${address.port}, "127.0.0.1", () => socket.write("ready"));
socket.on("error", () => process.exit(1));
`,
  );
  return {
    server,
    sockets,
    connected: connected.promise,
    get receivedBytes() {
      return receivedBytes;
    },
    uploadPack: [requireNodeTool("node"), uploadPack].map(shellEscape).join(" "),
  };
}
