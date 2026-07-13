import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { searchVisibleSessionTranscripts } from "./agent-scope.ts";

describe("searchVisibleSessionTranscripts", () => {
  it("batches every visible session within the protocol key limit", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ results: [] }));
    const sessions = Array.from(
      { length: 201 },
      (_, index) => ({ key: `agent:main:session-${index}` }) as GatewaySessionRow,
    );

    await searchVisibleSessionTranscripts({
      client: { request } as unknown as GatewayBrowserClient,
      query: "needle",
      sessions,
      resolveAgentId: () => "main",
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ sessionKeys: sessions.slice(0, 200).map((row) => row.key) }),
    );
    expect(request.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ sessionKeys: [sessions[200]?.key] }),
    );
  });
});
