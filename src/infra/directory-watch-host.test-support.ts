import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { installDirectoryWatchPort, watchDirectory } from "./directory-watch-host.js";

const { directory, port } = workerData as { directory: string; port: MessagePort };
const parent = parentPort!;
childProcess.spawn = () => {
  throw new Error("Unexpected second directory watch helper");
};
syncBuiltinESMExports();
installDirectoryWatchPort(port);
watchDirectory(directory, (_event, filename) => {
  // Node worker ports do not have a target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parent.postMessage(filename);
}).on("error", (error) => {
  throw error;
});
parent.on("message", () => {});
