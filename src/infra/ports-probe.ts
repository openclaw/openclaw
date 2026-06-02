import net from "node:net";

/** Probe whether a TCP port can be bound with Node's normal listen semantics. */
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
        // The probe only needs bind proof; close immediately so callers can claim the port.
        tester.close(() => resolve());
      })
      .listen(listenOptions);
  });
}
