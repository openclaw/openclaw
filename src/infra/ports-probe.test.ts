// Tests local port probing and availability detection.
import net from "node:net";
import { describe, expect, it, vi, type TestContext } from "vitest";
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
    let signalClose: () => void = () => {};
    const closeSignaled = new Promise<void>((resolve) => {
      signalClose = resolve;
    });
    let releaseClose: () => void = () => {};
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
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
});
