import { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { withLoopbackTestServer } from "../../commands/loopback-server.test-support.js";
import * as lifecycle from "./lifecycle.runtime.js";
import { GatewayUpdateSuccessor } from "./update-successor.js";

it("observes successor readiness without reopening shared state after custody transfer", async () => {
  const forbidden = () => {
    throw new Error("retired Gateway reopened shared state");
  };
  const child = new ChildProcess();
  const runtime = {
    ...lifecycle,
    readRestartSentinelReadOnly: forbidden,
    writeRestartSentinelIfUnchanged: forbidden,
    waitForGatewayHealthyRestart: forbidden,
  };
  const successor = new GatewayUpdateSuccessor(
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime,
  );
  const server = createServer((_request, response) => {
    response.writeHead(200).end('{"ready":true}');
  });
  await withLoopbackTestServer(server, async (port) => {
    await expect(
      successor.observeReadiness(child, {
        port,
        host: "127.0.0.1",
        beforeWait: () => {},
      }),
    ).resolves.toBe(true);
    expect(successor.committed).toBe(true);
  });
});
