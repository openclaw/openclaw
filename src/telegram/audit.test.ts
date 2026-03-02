import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let collectTelegramUnmentionedGroupIds: typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
let auditTelegramGroupMembership: typeof import("./audit.js").auditTelegramGroupMembership;

function mockGetChatMemberStatus(status: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { status } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

async function auditSingleGroup() {
  return auditTelegramGroupMembership({
    token: "t",
    botId: 123,
    groupIds: ["-1001"],
    timeoutMs: 5000,
  });
}

describe("telegram audit", () => {
  beforeAll(async () => {
    ({ collectTelegramUnmentionedGroupIds, auditTelegramGroupMembership } =
      await import("./audit.js"));
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects unmentioned numeric group ids and flags wildcard", async () => {
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
    mockGetChatMemberStatus("member");
    const res = await auditSingleGroup();
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.chatId).toBe("-1001");
    expect(res.groups[0]?.status).toBe("member");
  });

  it("reports bot not in group when status is left", async () => {
    mockGetChatMemberStatus("left");
    const res = await auditSingleGroup();
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("left");
  });
});
