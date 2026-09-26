// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsListTool } from "./sessions-list-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("./in-process-gateway.js", () => ({
  hasGatewayToolRoutingContext: () => false,
  getInProcessGatewayToolContext: () => undefined,
  callAgentToolGatewayRequest: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
}));

function mockSessionPages(pages: Array<Array<Record<string, unknown>>>, initialOffset = 0) {
  let pageIndex = 0;
  let nextOffset = initialOffset;
  mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
    const request = opts as { params?: { limit?: number; offset?: number } };
    expect(request.params).toEqual(expect.objectContaining({ limit: 200, offset: nextOffset }));
    const sessions = pages[pageIndex] ?? [];
    pageIndex += 1;
    nextOffset += sessions.length;
    return {
      path: "/tmp/sessions.json",
      sessions,
      hasMore: pageIndex < pages.length,
      nextOffset: pageIndex < pages.length ? nextOffset : null,
    };
  });
}

import { VALID_CONFIG, getSessionsListDetails, sessionRow } from "./sessions-list.test-support.js";

describe("sessions-list inventory queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it.each([
    { group: "P1 issues", pinned: true, activeOnly: true, excludeSubagents: true },
    { group: "", pinned: false, activeOnly: false, excludeSubagents: false },
  ])(
    "forwards exact inventory filters without turning explicit actor IDs into identity: %o",
    async (flags) => {
      mocks.gatewayCall.mockResolvedValue({ sessions: [] });
      const params = {
        ...flags,
        ownerId: "profile-owner",
        creatorId: "profile-creator",
        projectId: "project-inventory",
        workspaceDir: "/work/inventory",
        agentId: "main",
        label: "inventory",
        search: "needle",
        activeMinutes: 30,
        archived: "all",
        offset: 7,
        limit: 2,
        kinds: ["other"],
        includeDerivedTitles: true,
        includeLastMessage: true,
      };
      const tool = createSessionsListTool({ config: VALID_CONFIG });

      expect(Value.Check(tool.parameters, params)).toBe(true);
      await tool.execute("filtered-inventory", params);

      expect(mocks.gatewayCall).toHaveBeenCalledExactlyOnceWith({
        method: "sessions.list",
        params: {
          ...flags,
          ownerId: "profile-owner",
          creatorId: "profile-creator",
          profileRelation: undefined,
          projectId: "project-inventory",
          workspaceDir: "/work/inventory",
          agentId: "main",
          label: "inventory",
          search: "needle",
          activeMinutes: 30,
          archived: "all",
          offset: 7,
          limit: 200,
          includeDerivedTitles: false,
          includeLastMessage: false,
          includeGlobal: true,
          includeUnknown: true,
          spawnedBy: undefined,
        },
      });
    },
  );

  it.each([
    ["owned", undefined, undefined],
    ["created", undefined, undefined],
    ["involving", undefined, undefined],
    ["owned", "profile-trusted", "profile-other"],
    ["created", "profile-other", "profile-trusted"],
    ["involving", "profile-other", "profile-third"],
  ] as const)(
    "binds %s to the trusted profile and preserves independent actor filters",
    async (relationship, ownerId, creatorId) => {
      mocks.gatewayCall.mockResolvedValue({ sessions: [] });
      const tool = createSessionsListTool({
        config: VALID_CONFIG,
        requesterProfileId: "profile-trusted",
      });
      await tool.execute("related-inventory", {
        relationship,
        ownerId,
        creatorId,
        requesterProfileId: "profile-forged",
      });
      expect(mocks.gatewayCall).toHaveBeenCalledExactlyOnceWith({
        method: "sessions.list",
        params: expect.objectContaining({
          ownerId,
          creatorId,
          profileRelation: { profileId: "profile-trusted", relationship },
        }),
      });
    },
  );

  it.each(["owned", "created", "involving"])(
    "rejects %s without trusted requester identity before dispatch even with explicit actor filters",
    async (relationship) => {
      const tool = createSessionsListTool({ config: VALID_CONFIG });

      await expect(
        tool.execute("untrusted-relationship", {
          relationship,
          requesterProfileId: "profile-forged",
          ownerId: "profile-forged",
          creatorId: "profile-forged",
        }),
      ).rejects.toThrow("relationship requires an authenticated requesting user");
      expect(mocks.gatewayCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    { relationship: "owned", ownerId: "profile-other" },
    { relationship: "created", creatorId: "profile-other" },
  ])("leaves $relationship intersections and profile aliases to the Gateway", async (params) => {
    mocks.gatewayCall.mockResolvedValue({ sessions: [] });
    const tool = createSessionsListTool({
      config: VALID_CONFIG,
      requesterProfileId: "profile-trusted",
    });
    await tool.execute("intersected-relationship", params);
    expect(mocks.gatewayCall).toHaveBeenCalledExactlyOnceWith({
      method: "sessions.list",
      params: expect.objectContaining({
        profileRelation: { profileId: "profile-trusted", relationship: params.relationship },
        ownerId: "ownerId" in params ? params.ownerId : undefined,
        creatorId: "creatorId" in params ? params.creatorId : undefined,
      }),
    });
  });

  it("keeps a sandboxed main session clamped to spawned rows", async () => {
    mocks.gatewayCall.mockImplementation(async (request: unknown) => {
      expect(request).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ spawnedBy: "agent:main:main" }),
        }),
      );
      return { sessions: [sessionRow("agent:main:slack:channel:unspawned", "channel")] };
    });

    const result = await createSessionsListTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
      config: { ...VALID_CONFIG, tools: { sessions: { visibility: "all" } } },
    }).execute("sandbox-main", {});

    expect(getSessionsListDetails(result).sessions).toEqual([]);
  });

  it.each([
    {
      name: "hidden and global rows",
      params: { limit: 1 },
      pages: [
        [
          { key: "global", kind: "global", classification: "global", agentId: "main" },
          sessionRow("agent:other:dashboard:hidden", "dashboard", "other"),
        ],
        [sessionRow("agent:main:main", "main")],
      ],
    },
    {
      name: "non-matching kinds",
      params: { kinds: ["main"], limit: 1 },
      pages: [[sessionRow("agent:main:dashboard:other")], [sessionRow("agent:main:main", "main")]],
    },
  ])("fills the requested output limit past $name", async ({ params, pages }) => {
    mockSessionPages(pages);

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "paged-list",
      params,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
      "agent:main:main",
    ]);
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "default", limit: undefined, expectedLimit: 100 },
    { name: "maximum", limit: 200, expectedLimit: 200 },
    { name: "legacy larger request", limit: 201, expectedLimit: 200 },
    { name: "legacy bulk request", limit: 1000, expectedLimit: 200 },
  ])(
    "returns a bounded $name page and resumes at the next unread Gateway row",
    async ({ limit, expectedLimit }) => {
      const inventory = Array.from({ length: 201 }, (_, index) =>
        sessionRow("agent:main:dashboard:row-" + index),
      );
      mocks.gatewayCall.mockImplementation(
        async ({ params }: { params: { offset: number; limit: number } }) => {
          expect(params.limit).toBe(200);
          const sessions = inventory.slice(params.offset, params.offset + params.limit);
          const nextOffset = params.offset + sessions.length;
          return { sessions, hasMore: nextOffset < inventory.length, nextOffset };
        },
      );
      const tool = createSessionsListTool({ config: VALID_CONFIG });

      expect(Value.Check(tool.parameters, { limit: 200, offset: 0 })).toBe(true);
      expect(Value.Check(tool.parameters, { limit: 201 })).toBe(true);
      expect(Value.Check(tool.parameters, { offset: -1 })).toBe(false);
      const first = getSessionsListDetails(await tool.execute("first-inventory", { limit }));

      expect(first).toMatchObject({
        count: expectedLimit,
        limitApplied: expectedLimit,
        hasMore: true,
        nextOffset: expectedLimit,
      });
      expect(first.sessions?.map((row) => row.key)).toEqual(
        inventory.slice(0, expectedLimit).map((row) => row.key),
      );
      expect(first).not.toHaveProperty("truncationReason");
      expect(mocks.gatewayCall).toHaveBeenCalledTimes(1);

      const second = getSessionsListDetails(
        await tool.execute("continued-inventory", {
          offset: first.nextOffset,
          limit: limit ?? 200,
        }),
      );

      expect(second).toMatchObject({
        count: inventory.length - expectedLimit,
        limitApplied: 200,
        hasMore: false,
      });
      expect(second.sessions?.map((row) => row.key)).toEqual(
        inventory.slice(expectedLimit).map((row) => row.key),
      );
      expect(second).not.toHaveProperty("nextOffset");
      expect(second).not.toHaveProperty("truncationReason");
    },
  );

  it("resumes a caller offset midway through a Gateway page after visibility and kind filtering", async () => {
    const hidden = sessionRow("agent:other:dashboard:hidden", "dashboard", "other");
    const firstRow = sessionRow("agent:main:dashboard:first");
    const secondRow = sessionRow("agent:main:dashboard:second");
    const finalRow = sessionRow("agent:main:dashboard:final");
    mockSessionPages(
      [[hidden, sessionRow("agent:main:main", "main"), firstRow, hidden, secondRow, finalRow]],
      40,
    );
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const first = getSessionsListDetails(
      await tool.execute("offset-inventory", { offset: 40, limit: 2, kinds: ["other"] }),
    );

    expect(first).toMatchObject({ count: 2, hasMore: true, nextOffset: 45, limitApplied: 2 });
    expect(first.sessions?.map((row) => row.key)).toEqual([firstRow.key, secondRow.key]);
    expect(first).not.toHaveProperty("truncationReason");
    mockSessionPages([[finalRow]], 45);

    const resumed = getSessionsListDetails(
      await tool.execute("offset-resume", { offset: first.nextOffset, limit: 2, kinds: ["other"] }),
    );

    expect(resumed).toMatchObject({ count: 1, hasMore: false });
    expect(resumed.sessions?.map((row) => row.key)).toEqual([finalRow.key]);
    expect(resumed).not.toHaveProperty("nextOffset");
  });

  it("reports exhaustion after scanning several sparse Gateway pages", async () => {
    const firstRow = sessionRow("agent:main:dashboard:first");
    const lastRow = sessionRow("agent:main:dashboard:last");
    mockSessionPages(
      [
        [sessionRow("agent:other:main", "main", "other")],
        [firstRow],
        [sessionRow("agent:main:dashboard:incognito-private"), lastRow],
      ],
      30,
    );
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const details = getSessionsListDetails(
      await tool.execute("sparse-exhaustion", { offset: 30, limit: 5 }),
    );

    expect(details).toMatchObject({ count: 2, hasMore: false, limitApplied: 5 });
    expect(details.sessions?.map((row) => row.key)).toEqual([firstRow.key, lastRow.key]);
    expect(details).not.toHaveProperty("nextOffset");
    expect(details).not.toHaveProperty("truncationReason");
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "returns a resumable five-page scan limit with partial visible rows=%s",
    async (includeVisible) => {
      const visibleRow = sessionRow("agent:main:dashboard:visible");
      const pages = Array.from({ length: 6 }, (_pageValue, page) =>
        Array.from({ length: 200 }, (_, index) =>
          includeVisible && page === 0 && index === 199
            ? visibleRow
            : sessionRow(
                "agent:other:dashboard:hidden-" + page + "-" + index,
                "dashboard",
                "other",
              ),
        ),
      );
      mockSessionPages(pages, 10);
      const tool = createSessionsListTool({ config: VALID_CONFIG });

      const details = getSessionsListDetails(
        await tool.execute("scan-cap", { offset: 10, limit: 2 }),
      );

      expect(details).toMatchObject({
        count: includeVisible ? 1 : 0,
        hasMore: true,
        nextOffset: 1010,
        limitApplied: 2,
        truncationReason: "scan-limit",
      });
      expect(details.sessions?.map((row) => row.key)).toEqual(
        includeVisible ? [visibleRow.key] : [],
      );
      expect(mocks.gatewayCall).toHaveBeenCalledTimes(5);
      expect(Value.Check(tool.outputSchema!, details)).toBe(true);
      const finalRow = sessionRow("agent:main:dashboard:after-cap");
      mockSessionPages([[finalRow]], 1010);

      const resumed = getSessionsListDetails(
        await tool.execute("scan-cap-resume", { offset: details.nextOffset, limit: 2 }),
      );

      expect(resumed).toMatchObject({ count: 1, hasMore: false });
      expect(resumed.sessions?.map((row) => row.key)).toEqual([finalRow.key]);
      expect(resumed).not.toHaveProperty("nextOffset");
      expect(resumed).not.toHaveProperty("truncationReason");
    },
  );

  it("keeps pretty JSON within 64 KiB and resumes at the first byte-omitted row", async () => {
    const firstRow = { ...sessionRow("agent:main:dashboard:first"), label: "界".repeat(12_000) };
    const omittedRow = {
      ...sessionRow("agent:main:dashboard:omitted"),
      label: "界".repeat(12_000),
    };
    const finalRow = sessionRow("agent:main:dashboard:final");
    mockSessionPages(
      [
        [
          sessionRow("agent:other:dashboard:hidden", "dashboard", "other"),
          firstRow,
          sessionRow("agent:main:main", "main"),
          omittedRow,
          finalRow,
        ],
      ],
      20,
    );
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("byte-cap", { offset: 20, limit: 3, kinds: ["other"] });
    const details = getSessionsListDetails(result);
    const text = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");

    expect(details).toMatchObject({
      count: 1,
      hasMore: true,
      nextOffset: 23,
      limitApplied: 3,
      truncationReason: "byte-limit",
    });
    expect(details.sessions?.map((row) => row.key)).toEqual([firstRow.key]);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(text).toBe(JSON.stringify(result.details, null, 2));
    expect(Value.Check(tool.outputSchema!, details)).toBe(true);
    mockSessionPages([[omittedRow, finalRow]], 23);

    const resumed = getSessionsListDetails(
      await tool.execute("byte-cap-resume", {
        offset: details.nextOffset,
        limit: 3,
        kinds: ["other"],
      }),
    );

    expect(resumed.sessions?.map((row) => row.key)).toEqual([omittedRow.key, finalRow.key]);
    expect(resumed).toMatchObject({ count: 2, hasMore: false });
    expect(resumed).not.toHaveProperty("nextOffset");
    expect(resumed).not.toHaveProperty("truncationReason");
  });

  it("returns metadata instead of failing an oversized inline-preview request", async () => {
    const entry = {
      ...sessionRow("agent:main:main", "main"),
      derivedTitle: "title",
      lastMessagePreview: "preview",
    };
    mocks.gatewayCall.mockImplementation(async ({ method }: { method: string }) =>
      method === "sessions.list"
        ? { sessions: [entry] }
        : {
            messages: [
              { role: "assistant", content: [{ type: "text", text: "界".repeat(30_000) }] },
            ],
          },
    );
    const tool = createSessionsListTool({ config: VALID_CONFIG });
    const result = await tool.execute("oversized-preview", { messageLimit: 1 });
    expect(result.details).toMatchObject({ count: 1, hasMore: false, enrichmentOmitted: true });
    const rows = getSessionsListDetails(result).sessions;
    expect(rows?.[0]?.key).toBe(entry.key);
    expect(rows?.[0]).not.toHaveProperty("messages");
    expect(rows?.[0]).not.toHaveProperty("derivedTitle");
    expect(rows?.[0]).not.toHaveProperty("lastMessagePreview");
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it("fails explicitly when metadata alone cannot fit without losing associations", async () => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [{ ...sessionRow("agent:main:main", "main"), label: "界".repeat(30_000) }],
    });
    await expect(
      createSessionsListTool({ config: VALID_CONFIG }).execute("oversized-metadata", {}),
    ).rejects.toThrow("Session metadata exceeds the 64 KiB result budget");
  });

  it.each([
    { name: "stalled", nextOffset: 20, empty: false },
    { name: "missing", nextOffset: undefined, empty: false },
    { name: "skipped", nextOffset: 22, empty: false },
    { name: "fractional", nextOffset: 21.5, empty: false },
    { name: "empty stalled page", nextOffset: 20, empty: true },
  ])("fails visibly when Gateway pagination is $name", async ({ nextOffset, empty }) => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: empty ? [] : [sessionRow("agent:other:main", "main", "other")],
      hasMore: true,
      nextOffset,
    });

    await expect(
      createSessionsListTool({ config: VALID_CONFIG }).execute("invalid-cursor", {
        offset: 20,
        limit: 1,
      }),
    ).rejects.toThrow("sessions.list returned invalid pagination");
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid continuation metadata even when the output page is full", async () => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [sessionRow("agent:main:main", "main")],
      hasMore: true,
      nextOffset: 0,
    });
    await expect(
      createSessionsListTool({ config: VALID_CONFIG }).execute("full-page-cursor", { limit: 1 }),
    ).rejects.toThrow("sessions.list returned invalid pagination");
  });

  it("does not advertise or silently ignore live-activity filtering in embedded mode", async () => {
    const tool = createSessionsListTool({ config: VALID_CONFIG, supportsActiveOnly: false });
    expect(tool.parameters).not.toHaveProperty("properties.activeOnly");
    await expect(tool.execute("embedded-activity", { activeOnly: true })).rejects.toThrow(
      "activeOnly requires a Gateway-backed inventory",
    );
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });

  it.each(["ownerId", "creatorId", "projectId", "workspaceDir", "relationship"])(
    "does not broaden an empty explicit %s filter",
    async (field) => {
      const tool = createSessionsListTool({
        config: VALID_CONFIG,
        requesterProfileId: "profile-ada",
      });
      await expect(tool.execute("blank-filter", { [field]: "  " })).rejects.toThrow("required");
      expect(mocks.gatewayCall).not.toHaveBeenCalled();
    },
  );

  it("deduplicates rows when a changing Gateway page overlaps the prior page", async () => {
    const first = sessionRow("agent:main:dashboard:first");
    const overlap = sessionRow("agent:main:dashboard:overlap");
    const finalRow = { ...first, key: "agent:main:dashboard:final" };
    mockSessionPages([
      [first, overlap],
      [overlap, finalRow],
    ]);

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "overlapping-list",
      { limit: 3 },
    );
    const keys = getSessionsListDetails(result).sessions?.map((session) => session.key) ?? [];

    expect(keys).toEqual([first.key, overlap.key, finalRow.key]);
  });
});
