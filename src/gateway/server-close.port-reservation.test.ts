import net from "node:net";
import { expect, it } from "vitest";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("keeps a second Gateway's port owned while the first Gateway starts", async () => {
  const fixture = await createGatewayMetadataCloseFixture("port-reservation");
  const competitor = net.createServer();
  try {
    const firstPort = await fixture.reservePort();
    const secondPort = await fixture.reservePort();
    await fixture.start(firstPort);
    const collision = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      competitor.once("error", resolve);
      competitor.listen(secondPort, "127.0.0.1", () => resolve(undefined));
    });
    const second = await fixture.start(secondPort);
    expect(collision?.code).toBe("EADDRINUSE");
    const response = await fetch(`http://127.0.0.1:${secondPort}/healthz`);
    await response.text();
    expect(response.ok).toBe(true);
    await second.close();
    await new Promise<void>((resolve, reject) => {
      competitor.once("error", reject);
      competitor.listen(secondPort, "127.0.0.1", resolve);
    });
  } finally {
    await new Promise<void>((resolve) => {
      competitor.close(() => resolve());
    });
    await fixture.cleanup();
  }
});
