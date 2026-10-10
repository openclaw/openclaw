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
  it.each(["bind", "probe"] as const)(
    "cancels an already-aborted %s without opening a listener",
    async (operation) => {
      const controller = new AbortController();
      const reason = new Error("probe cancelled");
      controller.abort(reason);
      const bind = vi.spyOn(net, "createServer");
      try {
        await expect(
          operation === "bind"
            ? tryListenOnPort({
                port: 0,
                host: "127.0.0.1",
                exclusive: true,
                signal: controller.signal,
              })
            : probePortUsage(0, ["127.0.0.1"], controller.signal),
        ).rejects.toBe(reason);
        expect(bind).not.toHaveBeenCalled();
      } finally {
        bind.mockRestore();
      }
    },
  );

  it.for([false, true])(
    "waits for listener close before settling (cancelled=%s)",
    async (cancelled, { skip }) => {
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
        let settled = false;
        const pending = (
          cancelled
            ? probePortUsage(0, ["127.0.0.1", "127.0.0.2"], controller.signal)
            : tryListenOnPort({ port: 0, host: "127.0.0.1", exclusive: true })
        ).then((value) => {
          settled = true;
          return value;
        });
        const first = await Promise.race([
          entered.promise.then(() => "closing"),
          pending.then(
            () => "settled",
            (error: unknown) => error,
          ),
        ]);
        if (!cancelled && first instanceof Error && isErrno(first) && first.code === "EPERM") {
          skip("TCP listener bind unavailable: EPERM");
        }
        expect(first).toBe("closing");
        expect(settled).toBe(false);
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
      } finally {
        release.resolve();
        close.mockRestore();
        connect.mockRestore();
        bind.mockRestore();
      }
    },
  );

  it("rejects when the port is already in use", async ({ skip }) => {
    await withListeningServer(skip, async (address) => {
      const pending = tryListenOnPort({ port: address.port, host: "127.0.0.1" });
      await expect(pending).rejects.toBeInstanceOf(Error);
      await expect(pending).rejects.toMatchObject({
        code: "EADDRINUSE",
        address: "127.0.0.1",
        port: address.port,
        syscall: "listen",
      });
    });
  });
});

describe("probePortUsage", () => {
  it.for(["127.0.0.1", "127.0.0.2"])(
    "reports a listener on %s as busy and respects the requested interface",
    async (host, { skip }) => {
      await withListeningServer(
        skip,
        async (address) => {
          await expect(probePortUsage(address.port)).resolves.toBe("busy");
          if (host === "127.0.0.2") {
            await expect(probePortUsage(address.port, ["127.0.0.1"])).resolves.toBe("free");
          }
        },
        host,
      );
    },
  );

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
