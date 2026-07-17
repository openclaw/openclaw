import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "./fetch-guard.js";

const REJECTION_TIMEOUT_MS = 1_000;
const SOCKET_RELEASE_TIMEOUT_MS = 1_000;

type RedirectScenario = {
  path: string;
  location?: string;
  maxRedirects?: number;
  expectedError: RegExp;
};

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function expectRejectedRedirectToReleaseDispatcher(
  scenario: RedirectScenario,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(302, {
      "content-type": "text/plain",
      ...(scenario.location ? { location: scenario.location } : {}),
    });
    // Keep the redirect body open so rejection must cancel it before the
    // dispatcher can release its connection promptly.
    response.write("pending redirect body");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await listen(server);

  try {
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        expect(
          fetchWithSsrFGuard({
            url: `${origin}${scenario.path}`,
            policy: { allowedOrigins: [origin] },
            ...(scenario.maxRedirects === undefined
              ? {}
              : { maxRedirects: scenario.maxRedirects }),
          }),
        ).rejects.toThrow(scenario.expectedError),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("redirect rejection did not complete promptly")),
            REJECTION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    await vi.waitFor(() => expect(sockets.size).toBe(0), {
      timeout: SOCKET_RELEASE_TIMEOUT_MS,
    });
  } finally {
    await close(server, sockets);
  }
}

describe("fetchWithSsrFGuard real redirect cleanup", () => {
  it.each<RedirectScenario>([
    {
      path: "/missing-location",
      expectedError: /Redirect missing location header/u,
    },
    {
      path: "/loop",
      location: "/loop",
      expectedError: /Redirect loop detected/u,
    },
    {
      path: "/limit",
      location: "/next",
      maxRedirects: 0,
      expectedError: /Too many redirects/u,
    },
  ])("rejects $path promptly and releases the Undici connection", async (scenario) => {
    await expectRejectedRedirectToReleaseDispatcher(scenario);
  });
});
