import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { vi } from "vitest";
// Install download test utilities provide isolated state and workspace paths.
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { fetchWithSsrFGuardMock } from "./install-test-mocks.js";

/** Creates isolated OpenClaw state for install download tests. */
export async function createInstallDownloadTestState(): Promise<OpenClawTestState> {
  return await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skills-install-",
  });
}

export async function withDownloadServer(
  respond: (response: ServerResponse) => Promise<void> | void,
  run: (origin: string, release: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    void Promise.resolve(respond(response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral loopback server address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const release = vi.fn();
  const actualFetchGuard = await vi.importActual<typeof import("../../infra/net/fetch-guard.js")>(
    "../../infra/net/fetch-guard.js",
  );
  fetchWithSsrFGuardMock.mockImplementation(async (...args: unknown[]) => {
    const params = args[0] as Parameters<typeof actualFetchGuard.fetchWithSsrFGuard>[0];
    const guarded = await actualFetchGuard.fetchWithSsrFGuard({
      ...params,
      policy: { allowedOrigins: [origin] },
    });
    return {
      ...guarded,
      release: async () => {
        release();
        await guarded.release();
      },
    };
  });

  try {
    await run(origin, release);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
