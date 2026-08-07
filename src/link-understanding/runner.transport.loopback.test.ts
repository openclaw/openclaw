// Transport regression: verifies that a stalled HTTP error body is cancelled
// before the guarded fetch release closes the dispatcher.
// Uses a real loopback HTTP server to prove the socket lifecycle.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  status: 500,
  socketClosed: undefined as Promise<void> | undefined,
  requestCount: 0,
  releases: [] as Array<{
    bodyIsNull: boolean;
    bodyUsed: boolean;
    socketClosedBeforeGuardRelease: boolean;
  }>,
}));

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("Link understanding test server did not receive a request");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              "Link understanding error-response body was not canceled before guarded release",
            ),
          );
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout,
  };
});

const { runLinkUnderstanding } = await import("./runner.js");

const RESPONSE_BODY = '{"error":"internal server error"}';

let server: Server;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((request, response) => {
    loopback.requestCount++;
    loopback.socketClosed = new Promise<void>((resolve) => {
      request.socket.once("close", resolve);
    });
    response.writeHead(loopback.status, {
      "content-length": String(RESPONSE_BODY.length + 1_024),
      "content-type": "application/json",
    });
    response.write(RESPONSE_BODY);
    // Don't end the response — the body stays open until cancelled.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  loopback.baseUrl = `http://127.0.0.1:${address.port}/page`;
});

afterAll(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  loopback.status = 500;
  loopback.socketClosed = undefined;
  loopback.requestCount = 0;
  loopback.releases = [];
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.runCommandWithTimeout.mockReset();
});

function cfg() {
  return {
    tools: {
      links: {
        enabled: true,
        models: [{ type: "cli", command: "summarize" }],
      },
    },
  } as OpenClawConfig;
}

function ctx(body: string): MsgContext {
  return { Body: body } as MsgContext;
}

describe("link understanding guarded fetch transport", () => {
  it("cancels a stalled 500 error body before guarded release", async () => {
    // Set up fetchWithSsrFGuard mock to use the real loopback server
    mocks.fetchWithSsrFGuard.mockImplementation(
      async (params: { url: string; timeoutMs: number }) => {
        const response = await fetch(loopback.baseUrl, {
          signal: AbortSignal.timeout(params.timeoutMs),
        });
        const guarded = { response, finalUrl: loopback.baseUrl };
        const release = async () => {
          let socketClosedBeforeGuardRelease = false;
          try {
            await waitForSocketClose(loopback.socketClosed);
            socketClosedBeforeGuardRelease = true;
          } finally {
            loopback.releases.push({
              bodyIsNull: guarded.response.body === null,
              bodyUsed: guarded.response.bodyUsed,
              socketClosedBeforeGuardRelease,
            });
          }
        };
        return { ...guarded, release };
      },
    );

    // Mock runCommandWithTimeout to return success
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "summary",
      termination: "exit",
    });

    // Use a public URL so extractLinksFromMessage extracts it
    const result = await runLinkUnderstanding({
      cfg: cfg(),
      ctx: ctx("see https://example.com/page"),
    });

    // The error body is not consumed by the CLI, so outputs should be empty.
    expect(result.outputs).toEqual([]);

    // Verify that the loopback server was hit.
    expect(loopback.requestCount).toBeGreaterThan(0);

    // Verify that the release was called and socket closed before release.
    expect(loopback.releases.length).toBeGreaterThan(0);
    for (const release of loopback.releases) {
      expect(release).toEqual({
        bodyIsNull: false,
        bodyUsed: true,
        socketClosedBeforeGuardRelease: true,
      });
    }
  });
});
