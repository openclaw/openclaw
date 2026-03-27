import { afterEach, describe, expect, it, vi } from "vitest";
import { createMctlAgentExternalTool } from "./mctl-agent-external-tool.js";

describe("mctl agent external tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("claims a ticket over direct HTTPS", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ lease_id: "lease-1", expires_at: "2026-03-25T10:00:00Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createMctlAgentExternalTool();
    const result = await tool.execute("tool-1", {
      action: "claim",
      claimUrl: "https://agent.mctl.ai/api/v1/tickets/t1/external-claims",
      callbackAuthValue: "Bearer cb-token",
      agentId: "openclaw-labs",
      eventId: "evt-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.mctl.ai/api/v1/tickets/t1/external-claims",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer cb-token",
        }),
      }),
    );
    expect(JSON.stringify(result)).toContain("lease-1");
  });

  it("submits a result callback with artifacts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createMctlAgentExternalTool();
    const result = await tool.execute("tool-2", {
      action: "result",
      resultUrl: "https://agent.mctl.ai/api/v1/tickets/t1/external-results",
      callbackAuthValue: "Bearer cb-token",
      agentId: "openclaw-labs",
      eventId: "evt-1",
      leaseId: "lease-1",
      idempotencyKey: "idem-1",
      status: "needs_human",
      summary: "Need operator review",
      prUrl: "https://github.com/mctlhq/mctl-gitops/pull/123",
      prNumber: 123,
      prRepo: "mctlhq/mctl-gitops",
      prBranch: "openclaw/ticket-123",
      prCommitSha: "deadbeef123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.mctl.ai/api/v1/tickets/t1/external-results",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          Authorization: "Bearer cb-token",
        }),
      }),
    );
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(String(request?.body ?? "")).toContain(
      '"pr_url":"https://github.com/mctlhq/mctl-gitops/pull/123"',
    );
    expect(String(request?.body ?? "")).toContain('"pr_number":"123"');
    expect(String(request?.body ?? "")).toContain('"repo":"mctlhq/mctl-gitops"');
    expect(String(request?.body ?? "")).toContain('"branch":"openclaw/ticket-123"');
    expect(String(request?.body ?? "")).toContain('"commit_sha":"deadbeef123"');
    expect(JSON.stringify(result)).toContain('"ok":true');
  });
});
