import net from "node:net";

/** Opens and closes a temporary listener to verify that a port can be bound. */
export async function tryListenOnPort(params: {
  port: number;
  host?: string;
  exclusive?: boolean;
}): Promise<void> {
  const listenOptions: net.ListenOptions = { port: params.port };
  if (params.host) {
    listenOptions.host = params.host;
  }
  if (typeof params.exclusive === "boolean") {
    listenOptions.exclusive = params.exclusive;
  }
  await new Promise<void>((resolve, reject) => {
    const tester = net
      .createServer()
      .once("error", (err) => reject(err))
      .once("listening", () => {
        // Binding succeeded; close immediately so the real server can claim the same port.
        tester.close(() => resolve());
      })
      .listen(listenOptions);
  });
}
