import { once } from "node:events";
import net from "node:net";
import { expect, it, onTestFinished, vi, type TestContext } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { isErrno } from "./errors.js";
import { probePortUsage, tryListenOnPort } from "./ports-probe.js";

const loopback = { port: 0, host: "127.0.0.1", exclusive: true } as const;

async function listenOnTestPort(skip: TestContext["skip"], host: string = loopback.host) {
  const server = net.createServer();
  onTestFinished(() => server[Symbol.asyncDispose]());
  try {
    await once(server.listen(0, host), "listening");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EADDRNOTAVAIL") {
      skip(`TCP listener bind unavailable: ${code}`);
    }
    throw err;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  return address.port;
}

it.each(["bind", "probe"] as const)("cancels an aborted %s before binding", async (operation) => {
  const signal = AbortSignal.abort(new Error("probe cancelled"));
  using bind = vi.spyOn(net, "createServer");
  await expect(
    operation === "bind"
      ? tryListenOnPort({ ...loopback, signal })
      : probePortUsage(0, [loopback.host], signal),
  ).rejects.toBe(signal.reason);
  expect(bind).not.toHaveBeenCalled();
});

it.for([false, true])("awaits listener close (cancelled=%s)", async (cancelled, { skip }) => {
  const entered = createDeferred();
  const release = createDeferred();
  onTestFinished(() => release.resolve());
  const controller = new AbortController();
  using close = vi.spyOn(net.Server.prototype, "close").mockImplementation(function (
    this: net.Server,
    callback,
  ) {
    close.mockRestore();
    return this.close((error) => {
      entered.resolve();
      void release.promise.then(() => callback?.(error));
    });
  });
  using connect = vi.spyOn(net, "connect");
  using bind = vi.spyOn(net, "createServer");
  let settled = false;
  const pending = (
    cancelled
      ? probePortUsage(0, ["127.0.0.1", "127.0.0.2"], controller.signal)
      : tryListenOnPort(loopback)
  ).then((value) => {
    settled = true;
    return value;
  });
  const first = await Promise.race([
    entered.promise.then(() => "closing"),
    pending.catch((error: unknown) => error),
  ]);
  if (!cancelled && first instanceof Error && isErrno(first) && first.code === "EPERM") {
    skip("TCP listener bind unavailable: EPERM");
  }
  expect({ first, settled }).toEqual({ first: "closing", settled: false });
  const reason = new Error("settle deadline expired");
  if (cancelled) {
    controller.abort(reason);
  }
  release.resolve();
  if (cancelled) {
    await expect(pending).rejects.toBe(reason);
    expect(connect).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledOnce();
  } else {
    await expect(pending).resolves.toBeGreaterThan(0);
  }
});

it("rejects when the port is already in use", async ({ skip }) => {
  const port = await listenOnTestPort(skip);
  const pending = tryListenOnPort({ port, host: loopback.host });
  await expect(pending).rejects.toBeInstanceOf(Error);
  await expect(pending).rejects.toMatchObject({
    code: "EADDRINUSE",
    address: "127.0.0.1",
    port,
    syscall: "listen",
  });
});
it.for(["127.0.0.1", "127.0.0.2"])(
  "probes only the requested interface: %s",
  async (host, { skip }) => {
    const port = await listenOnTestPort(skip, host);
    await expect(probePortUsage(port)).resolves.toBe("busy");
    if (host === "127.0.0.2") {
      await expect(probePortUsage(port, [loopback.host])).resolves.toBe("free");
    }
  },
);

// On IPv6-disabled Linux, `::` binds but `::1` confirmation times out or reports EADDRNOTAVAIL.
it.for([
  { host: "::", answer: "timeout", ipv6Loopback: "missing", expected: "free" },
  { host: "::", answer: "EADDRNOTAVAIL", ipv6Loopback: "missing", expected: "free" },
  { host: "::", answer: "timeout", ipv6Loopback: "present", expected: "unknown" },
  { host: "0.0.0.0", answer: "timeout", ipv6Loopback: "missing", expected: "unknown" },
] as const)(
  "$host/$answer with ::1 $ipv6Loopback is $expected",
  async ({ host, answer, ipv6Loopback, expected }, { skip }) => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    onTestFinished(() => claim.release());
    using createServer = vi.spyOn(net, "createServer");
    try {
      await tryListenOnPort({ port: claim.port, host });
      if (ipv6Loopback === "present") {
        await tryListenOnPort({ port: 0, host: "::1" });
      }
    } catch (err) {
      if (isErrno(err) && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) {
        skip(`host lacks the ${host} or ::1 address this case needs`);
      }
      throw err;
    }
    if (ipv6Loopback === "missing") {
      createServer.mockImplementation(() => {
        const server = new net.Server();
        const listen = server.listen.bind(server);
        server.listen = ((options: net.ListenOptions) => {
          if (options.host !== "::1") {
            return listen(options);
          }
          const error = Object.assign(new Error("listen EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" });
          process.nextTick(() => server.emit("error", error));
          return server;
        }) as net.Server["listen"];
        return server;
      });
    }
    using connect = vi.spyOn(net, "connect").mockImplementation(() => {
      const socket = new net.Socket();
      const error = Object.assign(new Error(`connect ${answer}`), { code: answer });
      setImmediate(() => (answer === "timeout" ? socket.emit("timeout") : socket.destroy(error)));
      return socket;
    });
    await expect(probePortUsage(claim.port, [host])).resolves.toBe(expected);
    expect(connect).toHaveBeenCalledOnce();
  },
);
