import net from "node:net";
import { describe, expect, it } from "vitest";
import { tryListenOnPort } from "./ports-probe.js";

describe("tryListenOnPort", () => {
  it("can bind and release an ephemeral loopback port", async () => {
    await expect(tryListenOnPort({ port: 0, host: "127.0.0.1", exclusive: true })).resolves.toBe(
      undefined,
    );
  });

  it("rejects when the port is already in use", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp address");
    }

    try {
      await expect(
        tryListenOnPort({ port: address.port, host: "127.0.0.1" }),
      ).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
