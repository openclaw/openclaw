import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "../../src/test-utils/ports.js";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createDeferred } from "../helpers/promise.js";
import { stopChildProcess } from "../helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const clickclackFixturePath = "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs";
const clickclackPluginWritePath =
  "scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs";

type ClickClackFixturePlugin = {
  outbound: {
    sendText(ctx: {
      cfg: { channels: { clickclack: { baseUrl: string; token: string } } };
      text: string;
      to: string;
    }): Promise<unknown>;
  };
};

async function listen(server: Server): Promise<string> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("e2e helper numeric env limits", () => {
  it("rejects oversized ClickClack fixture request bodies", async () => {
    const tempDir = tempDirs.make("openclaw-clickclack-fixture-");
    const port = await getFreePort();
    const child = spawn(process.execPath, [clickclackFixturePath], {
      env: {
        ...process.env,
        CLICKCLACK_FIXTURE_PORT: String(port),
        CLICKCLACK_FIXTURE_REQUEST_MAX_BYTES: "16",
        CLICKCLACK_FIXTURE_STATE: path.join(tempDir, "state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = createBoundedChildOutput();
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", output.append);
    }
    try {
      await expect
        .poll(() => output.text(), { timeout: 3_000, interval: 20 })
        .toContain(`clickclack fixture listening on ${port}`);

      const response = await fetch(`http://127.0.0.1:${port}/fixture/inbound`, {
        body: JSON.stringify({ body: "x".repeat(64) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body).toEqual({ error: "ClickClack fixture request body exceeded 16 bytes" });
    } finally {
      await stopChildProcess(child, 1_000);
    }
  });

  it.each([
    { name: "cancels response bodies", cancelBody: true, timeoutMs: 500 },
    {
      name: "clamps oversized timers before scheduling",
      cancelBody: false,
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
    },
  ])("Open WebUI HTTP probe $name", async ({ cancelBody, timeoutMs }) => {
    const { probeHttpStatus } = await import("../../scripts/e2e/lib/openwebui/http-probe.mjs");
    let canceled = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (cancelBody) {
        expect(init.headers).toEqual({ authorization: "Bearer token-123" });
      } else {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      return new Response(
        cancelBody
          ? new ReadableStream<Uint8Array>({
              cancel() {
                canceled = true;
              },
            })
          : null,
        { status: 200 },
      );
    }) as typeof fetch;
    await expect(
      probeHttpStatus({
        ...(cancelBody ? { bearer: "token-123" } : {}),
        fetchImpl,
        timeoutMs,
        url: "http://127.0.0.1/probe",
      }),
    ).resolves.toBe(true);
    expect(canceled).toBe(cancelBody);
  });

  it("bounds generated ClickClack plugin response bodies", async () => {
    const tempDir = tempDirs.make("openclaw-clickclack-plugin-");
    const headersSent = createDeferred();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      headersSent.resolve();
    });
    const baseUrl = await listen(server);
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(200));
    try {
      const result = spawnSync(process.execPath, [clickclackPluginWritePath, tempDir], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const generated = (await import(pathToFileURL(path.join(tempDir, "index.mjs")).href)) as {
        default: {
          register(api: {
            registerChannel(entry: { plugin: ClickClackFixturePlugin }): void;
          }): void;
        };
      };
      let plugin: ClickClackFixturePlugin | undefined;
      generated.default.register({
        registerChannel: ({ plugin: registeredPlugin }) => {
          plugin = registeredPlugin;
        },
      });
      if (!plugin) {
        throw new Error("generated ClickClack plugin did not register a channel");
      }

      const startedAt = Date.now();
      const request = plugin.outbound.sendText({
        cfg: { channels: { clickclack: { baseUrl, token: "x" } } },
        text: "hello",
        to: "channel:general",
      });
      const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
      await headersSent.promise;
      await rejection;

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      timeoutSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
