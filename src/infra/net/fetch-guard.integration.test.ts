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
  /** Expected body.cancel() calls before rejection (loop/limit cancel each hop). */
  expectedCancelCount: number;
};

const REDIRECT_SCENARIOS: RedirectScenario[] = [
  {
    path: "/missing-location",
    expectedError: /Redirect missing location header/u,
    expectedCancelCount: 1,
  },
  {
    // Location resolves to the same URL as the request, so the second visit key
    // collides immediately after one hop (one body cancel, then loop error).
    path: "/loop",
    location: "/loop",
    expectedError: /Redirect loop detected/u,
    expectedCancelCount: 1,
  },
  {
    path: "/limit",
    location: "/next",
    maxRedirects: 0,
    expectedError: /Too many redirects/u,
    expectedCancelCount: 1,
  },
];

function createTrackedOpenBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Leave the body open so rejection must cancel rather than drain it.
    },
    cancel() {
      onCancel();
    },
  });
}

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

async function raceRejection(run: () => Promise<unknown>, expectedError: RegExp): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      expect(run()).rejects.toThrow(expectedError),
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
}

/**
 * Instrumented body proof: fails if cancel is not invoked. Socket teardown alone
 * cannot pass this harness because the open body never drains without cancel.
 */
async function expectRejectedRedirectCancelsBody(scenario: RedirectScenario): Promise<void> {
  let cancelCount = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const location =
      scenario.location === undefined ? undefined : new URL(scenario.location, parsed).toString();
    return new Response(
      createTrackedOpenBody(() => {
        cancelCount += 1;
      }),
      {
        status: 302,
        headers: {
          "content-type": "text/plain",
          ...(location ? { location } : {}),
        },
      },
    );
  });

  await raceRejection(
    () =>
      fetchWithSsrFGuard({
        // Mocked fetch stays hermetic (no DNS) while still exercising redirect
        // rejection and body cancel counting.
        url: `https://public.example${scenario.path}`,
        fetchImpl,
        ...(scenario.maxRedirects === undefined ? {} : { maxRedirects: scenario.maxRedirects }),
      }),
    scenario.expectedError,
  );

  expect(cancelCount).toBe(scenario.expectedCancelCount);
}

/**
 * Real Undici + loopback server: prompt rejection and connection release under a
 * body left open on the wire. Supplemental to the cancel-count harness above.
 */
async function expectRejectedRedirectToReleaseDispatcher(
  scenario: RedirectScenario,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(302, {
      "content-type": "text/plain",
      ...(scenario.location ? { location: scenario.location } : {}),
    });
    // Keep the redirect body open so rejection must abandon the stream before
    // the client connection can return to idle promptly.
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
    await raceRejection(
      () =>
        fetchWithSsrFGuard({
          url: `${origin}${scenario.path}`,
          policy: { allowedOrigins: [origin] },
          ...(scenario.maxRedirects === undefined ? {} : { maxRedirects: scenario.maxRedirects }),
        }),
      scenario.expectedError,
    );

    await vi.waitFor(() => expect(sockets.size).toBe(0), {
      timeout: SOCKET_RELEASE_TIMEOUT_MS,
    });
  } finally {
    await close(server, sockets);
  }
}

describe("fetchWithSsrFGuard real redirect cleanup", () => {
  it.each(REDIRECT_SCENARIOS)(
    "cancels the open redirect body for $path (instrumented)",
    async (scenario) => {
      await expectRejectedRedirectCancelsBody(scenario);
    },
  );

  it.each(REDIRECT_SCENARIOS)(
    "rejects $path promptly and releases the Undici connection",
    async (scenario) => {
      await expectRejectedRedirectToReleaseDispatcher(scenario);
    },
  );
});
