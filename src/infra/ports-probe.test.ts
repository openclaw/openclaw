// Tests local port probing and availability detection.
import net from "node:net";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { isErrno } from "./errors.js";
import { probePortUsage, tryListenOnPort } from "./ports-probe.js";

async function withListeningServer(
  skip: TestContext["skip"],
  cb: (address: net.AddressInfo) => Promise<void>,
  host = "127.0.0.1",
): Promise<void> {
  await using server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => resolve());
    });
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

  await cb(address);
}

describe("tryListenOnPort", () => {
  it("rejects an already-aborted bind without opening a listener", async () => {
    const abortController = new AbortController();
    const reason = new Error("probe cancelled");
    abortController.abort(reason);

    await expect(
      tryListenOnPort({
        port: 0,
        host: "127.0.0.1",
        exclusive: true,
        signal: abortController.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("returns an ephemeral port only after its listener closes", async ({ skip }) => {
    const { promise: closeSignaled, resolve: signalClose } = createDeferred();
    const { promise: closeReleased, resolve: releaseClose } = createDeferred();
    const closeSpy = vi.spyOn(net.Server.prototype, "close").mockImplementation(function (
      this: net.Server,
      callback?: (error?: Error) => void,
    ) {
      closeSpy.mockRestore();
      return this.close((error?: Error) => {
        signalClose();
        void closeReleased.then(() => callback?.(error));
      });
    });

    try {
      let settled = false;
      const portPromise = tryListenOnPort({
        port: 0,
        host: "127.0.0.1",
        exclusive: true,
      }).then((port) => {
        settled = true;
        return port;
      });

      const firstEvent = await Promise.race([
        closeSignaled.then(() => "closing" as const),
        portPromise.then(
          () => "settled" as const,
          (error: unknown) => error,
        ),
      ]);
      if (firstEvent instanceof Error && (firstEvent as NodeJS.ErrnoException).code === "EPERM") {
        skip("TCP listener bind unavailable: EPERM");
      }
      expect(firstEvent).toBe("closing");
      expect(settled).toBe(false);
      releaseClose();
      await expect(portPromise).resolves.toBeGreaterThan(0);
    } finally {
      releaseClose();
      closeSpy.mockRestore();
    }
  });

  it("rejects when the port is already in use", async ({ skip }) => {
    await withListeningServer(skip, async (address) => {
      let rejection: NodeJS.ErrnoException | undefined;
      try {
        await tryListenOnPort({ port: address.port, host: "127.0.0.1" });
      } catch (err) {
        rejection = err as NodeJS.ErrnoException;
      }

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection?.code).toBe("EADDRINUSE");
      const listenError = rejection as
        | (NodeJS.ErrnoException & { address?: string; port?: number })
        | undefined;
      expect(listenError?.address).toBe("127.0.0.1");
      expect(listenError?.port).toBe(address.port);
      expect(rejection?.syscall).toBe("listen");
    });
  });
});

describe("probePortUsage", () => {
  it("does not open a listener after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("settle deadline expired");
    controller.abort(reason);
    const bind = vi.spyOn(net, "createServer");
    try {
      await expect(probePortUsage(0, ["127.0.0.1"], controller.signal)).rejects.toBe(reason);
      expect(bind).not.toHaveBeenCalled();
    } finally {
      bind.mockRestore();
    }
  });

  it("cancels a bind before TCP confirmation or another host probe", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    const close = vi.spyOn(net.Server.prototype, "close").mockImplementation(function (
      this: net.Server,
      callback?: (error?: Error) => void,
    ) {
      close.mockRestore();
      return this.close((error?: Error) => {
        entered.resolve();
        void release.promise.then(() => callback?.(error));
      });
    });
    const connect = vi.spyOn(net, "connect");
    const bind = vi.spyOn(net, "createServer");
    try {
      const result = probePortUsage(0, ["127.0.0.1", "127.0.0.2"], controller.signal).catch(
        (error: unknown) => error,
      );
      const first = await Promise.race([entered.promise.then(() => "closing"), result]);
      expect(first).toBe("closing");
      const reason = new Error("settle deadline expired");
      controller.abort(reason);
      release.resolve();
      expect(await result).toBe(reason);
      expect(connect).not.toHaveBeenCalled();
      expect(bind).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      close.mockRestore();
      connect.mockRestore();
      bind.mockRestore();
    }
  });

  it("reports an IPv4-only loopback listener as busy", async ({ skip }) => {
    await withListeningServer(skip, async (address) => {
      await expect(probePortUsage(address.port)).resolves.toBe("busy");
    });
  });

  it("can scope a probe to a free loopback address when another address owns the port", async ({
    skip,
  }) => {
    await withListeningServer(
      skip,
      async (address) => {
        await expect(probePortUsage(address.port)).resolves.toBe("busy");
        await expect(probePortUsage(address.port, ["127.0.0.1"])).resolves.toBe("free");
      },
      "127.0.0.2",
    );
  });

  // Linux with IPv6 disabled accepts a dual-stack `::` bind, but its missing `::1` target
  // times out on some kernels and fails with EADDRNOTAVAIL on others.
  it.for([
    { host: "::", answer: "timeout", ipv6Loopback: "missing", expected: "free" },
    { host: "::", answer: "EADDRNOTAVAIL", ipv6Loopback: "missing", expected: "free" },
    { host: "::", answer: "timeout", ipv6Loopback: "present", expected: "unknown" },
    { host: "0.0.0.0", answer: "timeout", ipv6Loopback: "missing", expected: "unknown" },
  ] as const)(
    "reports $expected when $host binds, its confirm gets $answer, and ::1 is $ipv6Loopback",
    async ({ host, answer, ipv6Loopback, expected }, { skip }) => {
      const claim = await acquireTestPortBlock({ offsets: [0] });
      const connect = vi.spyOn(net, "connect");
      const createServer = vi.spyOn(net, "createServer");
      try {
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
              const error = Object.assign(new Error("listen EADDRNOTAVAIL"), {
                code: "EADDRNOTAVAIL",
              });
              process.nextTick(() => server.emit("error", error));
              return server;
            }) as net.Server["listen"];
            return server;
          });
        }
        connect.mockImplementation(() => {
          const socket = new net.Socket();
          const error = Object.assign(new Error(`connect ${answer}`), { code: answer });
          setImmediate(() =>
            answer === "timeout" ? socket.emit("timeout") : socket.destroy(error),
          );
          return socket;
        });
        await expect(probePortUsage(claim.port, [host])).resolves.toBe(expected);
        expect(connect).toHaveBeenCalledOnce();
      } finally {
        connect.mockRestore();
        createServer.mockRestore();
        await claim.release();
      }
    },
  );
});
