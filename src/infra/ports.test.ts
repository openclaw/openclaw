import net from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./ports.js";

describe("ports helpers", () => {
  it("ensurePortAvailable rejects when port busy", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;
    await expect(ensurePortAvailable(port)).rejects.toBeInstanceOf(
      PortInUseError,
    );
    server.close();
  });

  it("handlePortError exits nicely on EADDRINUSE", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    await handlePortError(
      { code: "EADDRINUSE" },
      1234,
      "context",
      runtime,
    ).catch(() => {});
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
