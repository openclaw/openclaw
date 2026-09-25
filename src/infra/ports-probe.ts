// Probes local ports and reports listener availability.
import net from "node:net";
import { isErrno, toErrorObject } from "./errors.js";
import type { PortUsageStatus } from "./ports-types.js";

const PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"];
export const LOOPBACK_PORT_PROBE_HOSTS = ["127.0.0.1"] as const;

type ListenOnPortParams = {
  /** TCP port to probe; `0` lets the OS allocate an available ephemeral port. */
  port: number;
  /** Optional host/interface to bind during the probe. */
  host?: string;
  /** Whether the probe should request an exclusive server handle from Node. */
  exclusive?: boolean;
  /** Cancels an in-flight bind, including hostname resolution. */
  signal?: AbortSignal;
};

/** Opens and closes an ephemeral listener, returning the allocated port. */
export function tryListenOnPort(params: ListenOnPortParams & { port: 0 }): Promise<number>;
/** Opens and closes a temporary listener to verify that an explicit port can be bound. */
export function tryListenOnPort(params: ListenOnPortParams): Promise<void>;
export async function tryListenOnPort(params: ListenOnPortParams): Promise<number | void> {
  if (params.signal?.aborted) {
    throw params.signal.reason;
  }
  const listenOptions: net.ListenOptions = { port: params.port };
  if (params.host) {
    listenOptions.host = params.host;
  }
  if (typeof params.exclusive === "boolean") {
    listenOptions.exclusive = params.exclusive;
  }
  if (params.signal) {
    listenOptions.signal = params.signal;
  }
  return await new Promise<number | void>((resolve, reject) => {
    const clearAbort = () => params.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearAbort();
      reject(toErrorObject(params.signal?.reason, "Port probe aborted"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const tester = net
      .createServer()
      .once("error", (error) => {
        clearAbort();
        reject(error);
      })
      .once("listening", () => {
        const address = tester.address();
        if (!address || typeof address === "string") {
          tester.close(() => {
            clearAbort();
            reject(new Error("expected TCP listener address"));
          });
          return;
        }
        // Binding succeeded; close immediately so the real server can claim the same port.
        tester.close(() => {
          clearAbort();
          resolve(params.port === 0 ? address.port : undefined);
        });
      })
      .listen(listenOptions);
  });
}

/** Observe a listener without retaining its socket or cancellation hook. */
export async function probeTcpListener(
  port: number,
  host: string,
  signal?: AbortSignal,
): Promise<PortUsageStatus> {
  signal?.throwIfAborted();
  return await new Promise<PortUsageStatus>((resolve) => {
    const socket = net.connect({ host, port });
    let result: PortUsageStatus = "unknown";
    const destroy = () => socket.destroy();
    signal?.addEventListener("abort", destroy, { once: true });
    socket.once("connect", () => {
      result = "busy";
      destroy();
    });
    socket.once("error", (error) => {
      result = isErrno(error) && error.code === "ECONNREFUSED" ? "free" : "unknown";
      destroy();
    });
    socket.setTimeout(250, destroy);
    // Closing, not just requesting destruction, releases the probe's I/O and timer.
    socket.once("close", () => {
      signal?.removeEventListener("abort", destroy);
      resolve(result);
    });
  });
}

async function probePortOnHost(
  port: number,
  host: string,
  signal?: AbortSignal,
): Promise<PortUsageStatus | "skip"> {
  try {
    await tryListenOnPort({ port, host, exclusive: true, ...(signal ? { signal } : {}) });
    // A successful scoped bind can coexist with a wildcard listener on macOS.
    // Confirm the endpoint before declaring it free, even without lsof or ss.
    return await probeTcpListener(port, host, signal);
  } catch (err) {
    signal?.throwIfAborted();
    if (isErrno(err) && err.code === "EADDRINUSE") {
      return "busy";
    }
    if (isErrno(err) && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) {
      return "skip";
    }
    return "unknown";
  }
}

/** Checks selected local addresses without resolving listener diagnostics. */
export async function probePortUsage(
  port: number,
  probeHosts: readonly string[] = PORT_PROBE_HOSTS,
  signal?: AbortSignal,
): Promise<PortUsageStatus> {
  signal?.throwIfAborted();
  let sawUnknown = false;
  for (const host of probeHosts) {
    const result = await probePortOnHost(port, host, signal);
    signal?.throwIfAborted();
    if (result === "busy") {
      return "busy";
    }
    if (result === "unknown") {
      sawUnknown = true;
    }
  }
  return sawUnknown ? "unknown" : "free";
}
