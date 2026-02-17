import net from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("inspectPortUsage", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
  });

  it("reports busy when lsof is missing but loopback listener exists", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    runCommandWithTimeoutMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
    );

    try {
      const { inspectPortUsage } = await import("./ports-inspect.js");
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.errors?.some((err) => err.includes("ENOENT"))).toBe(true);
    } finally {
      server.close();
    }
  });
});
