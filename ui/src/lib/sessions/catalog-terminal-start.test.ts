import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalGatewayClient } from "../../components/terminal/terminal-connection.ts";
import { prepareCatalogTerminal, takePreparedCatalogTerminal } from "./catalog-terminal-start.ts";

const params = { catalogId: "codex", agentId: "main", hostId: "gateway:local", cwd: "/w" };

function createClient(sessionId: string) {
  const request = vi.fn(async (method: string) =>
    method === "sessions.catalog.startTerminal"
      ? { sessionId, agentId: "main", shell: "codex", cwd: "/w", confined: false }
      : {},
  );
  const client: TerminalGatewayClient = {
    request: request as TerminalGatewayClient["request"],
    addEventListener: () => () => undefined,
    forceReconnect: () => undefined,
  };
  return { client, request };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("prepareCatalogTerminal", () => {
  it("closes an unclaimed PTY when its handoff expires", async () => {
    vi.useFakeTimers();
    const { client, request } = createClient("pty-expired");
    await prepareCatalogTerminal(client, params, () => true);
    expect(request).not.toHaveBeenCalledWith("terminal.close", expect.anything());

    await vi.advanceTimersByTimeAsync(60_000);

    expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "pty-expired" });
    expect(takePreparedCatalogTerminal("pty-expired", client)).toBeNull();
  });

  it("hands a claimed PTY to its page without closing it", async () => {
    vi.useFakeTimers();
    const { client, request } = createClient("pty-claimed");
    await prepareCatalogTerminal(client, params, () => true);

    expect(takePreparedCatalogTerminal("pty-claimed", client)?.result.sessionId).toBe(
      "pty-claimed",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).not.toHaveBeenCalledWith("terminal.close", expect.anything());
  });
});
