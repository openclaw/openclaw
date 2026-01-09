import { beforeEach, describe, expect, it, vi } from "vitest";

describe("telegram audit", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects unmentioned numeric group ids and flags wildcard", async () => {
    const { collectTelegramUnmentionedGroupIds } = await import("./audit.js");
    const res = collectTelegramUnmentionedGroupIds({
      "*": { requireMention: false },
      "-1001": { requireMention: false },
      "@group": { requireMention: false },
      "-1002": { requireMention: true },
      "-1003": { requireMention: false, enabled: false },
    });
    expect(res.hasWildcardUnmentionedGroups).toBe(true);
    expect(res.groupIds).toEqual(["-1001"]);
    expect(res.unresolvedGroups).toBe(1);
  });

  it("audits membership via getChatMember", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, result: { status: "member" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.chatId).toBe("-1001");
    expect(res.groups[0]?.status).toBe("member");
  });

  it("reports bot not in group when status is left", async () => {
    const { auditTelegramGroupMembership } = await import("./audit.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { status: "left" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await auditTelegramGroupMembership({
      token: "t",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("left");
  });
});
