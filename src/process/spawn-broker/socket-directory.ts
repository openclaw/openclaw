import path from "node:path";

/** Darwin's shorter sockaddr_un budget also covers Linux output/resource sockets. */
export function fitsBrokerSocketPath(directory: string, socketName: string): boolean {
  return process.platform === "win32" || Buffer.byteLength(path.join(directory, socketName)) <= 103;
}
