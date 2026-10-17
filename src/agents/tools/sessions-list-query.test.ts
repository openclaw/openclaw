// Register closed mocks before runtime imports; keep the shared row fixtures real.
import "./sessions-list.mocks.test-support.js";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsListTool } from "./sessions-list-tool.js";

const { mocks } = await import("./sessions-list.mocks.test-support.js");

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

const createTool = () => createSessionsListTool({ config: VALID_CONFIG });
const sessionKeys = (details: ReturnType<typeof getSessionsListDetails>) =>
  details.sessions?.map((row) => row.key);
function expectExhausted(details: ReturnType<typeof getSessionsListDetails>, count: number) {
  expect(details).toMatchObject({ count, hasMore: false });
  expect(details).not.toHaveProperty("nextOffset");
  expect(details).not.toHaveProperty("truncationReason");
}

describe("sessions-list inventory queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("forwards exact inventory filters without turning explicit actor IDs into identity", async () => {
    mocks.gatewayCall.mockResolvedValue({ sessions: [] });
    const params = {
      group: "P1 issues",
      pinned: true,
      activeOnly: true,
      excludeSubagents: true,
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
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    const tool = createTool();

    const input = { ...params, kinds: ["other"] };
    expect(Value.Check(tool.parameters, input)).toBe(true);
    await tool.execute("filtered-inventory", input);

    expect(mocks.gatewayCall).toHaveBeenCalledExactlyOnceWith({
      method: "sessions.list",
      params: {
        ...params,
        profileRelation: undefined,
        limit: 200,
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        spawnedBy: undefined,
      },
    });
  });

  it("binds relationships to the trusted profile while leaving actor intersections to the Gateway", async () => {
    const relationship = "involving";
    const ownerId = "profile-other";
    const creatorId = "profile-third";
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
  });

  it("rejects relationships without trusted identity even with explicit actor filters", async () => {
    const tool = createTool();

    await expect(
      tool.execute("untrusted-relationship", {
        relationship: "involving",
        requesterProfileId: "profile-forged",
        ownerId: "profile-forged",
        creatorId: "profile-forged",
      }),
    ).rejects.toThrow("relationship requires an authenticated requesting user");
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
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

  it("fills the requested output limit past hidden and global rows", async () => {
    mockSessionPages([
      [
        { key: "global", kind: "global", classification: "global", agentId: "main" },
        sessionRow("agent:other:dashboard:hidden", "dashboard", "other"),
      ],
      [sessionRow("agent:main:main", "main")],
    ]);
    const result = await createTool().execute("paged-list", { limit: 1 });

    expect(sessionKeys(getSessionsListDetails(result))).toEqual(["agent:main:main"]);
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(2);
  });

  it("bounds a legacy larger request and resumes at the next unread Gateway row", async () => {
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
    const tool = createTool();

    expect(Value.Check(tool.parameters, { limit: 200, offset: 0 })).toBe(true);
    expect(Value.Check(tool.parameters, { limit: 201 })).toBe(true);
    expect(Value.Check(tool.parameters, { offset: -1 })).toBe(false);
    const first = getSessionsListDetails(await tool.execute("first-inventory", { limit: 201 }));

    expect(first).toMatchObject({
      count: 200,
      limitApplied: 200,
      hasMore: true,
      nextOffset: 200,
    });
    expect(sessionKeys(first)).toEqual(inventory.slice(0, 200).map((row) => row.key));
    expect(first).not.toHaveProperty("truncationReason");
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(1);

    const second = getSessionsListDetails(
      await tool.execute("continued-inventory", {
        offset: first.nextOffset,
        limit: 201,
      }),
    );

    expectExhausted(second, 1);
    expect(second.limitApplied).toBe(200);
    expect(sessionKeys(second)).toEqual(inventory.slice(200).map((row) => row.key));
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
    const tool = createTool();

    const details = getSessionsListDetails(
      await tool.execute("sparse-exhaustion", { offset: 30, limit: 5 }),
    );

    expectExhausted(details, 2);
    expect(details.limitApplied).toBe(5);
    expect(sessionKeys(details)).toEqual([firstRow.key, lastRow.key]);
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(3);
  });

  it("returns a resumable five-page scan limit with partial visible rows", async () => {
    const visibleRow = sessionRow("agent:main:dashboard:visible");
    const pages = Array.from({ length: 6 }, (_pageValue, page) =>
      Array.from({ length: 200 }, (_, index) =>
        page === 0 && index === 199
          ? visibleRow
          : sessionRow("agent:other:dashboard:hidden-" + page + "-" + index, "dashboard", "other"),
      ),
    );
    mockSessionPages(pages, 10);
    const tool = createTool();

    const details = getSessionsListDetails(
      await tool.execute("scan-cap", { offset: 10, limit: 2 }),
    );

    expect(details).toMatchObject({
      count: 1,
      hasMore: true,
      nextOffset: 1010,
      limitApplied: 2,
      truncationReason: "scan-limit",
    });
    expect(sessionKeys(details)).toEqual([visibleRow.key]);
    expect(mocks.gatewayCall).toHaveBeenCalledTimes(5);
    expect(Value.Check(tool.outputSchema!, details)).toBe(true);
    const finalRow = sessionRow("agent:main:dashboard:after-cap");
    mockSessionPages([[finalRow]], 1010);

    const resumed = getSessionsListDetails(
      await tool.execute("scan-cap-resume", { offset: details.nextOffset, limit: 2 }),
    );

    expectExhausted(resumed, 1);
    expect(sessionKeys(resumed)).toEqual([finalRow.key]);
  });

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
    const tool = createTool();

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
    expect(sessionKeys(details)).toEqual([firstRow.key]);
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

    expect(sessionKeys(resumed)).toEqual([omittedRow.key, finalRow.key]);
    expectExhausted(resumed, 2);
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
    const tool = createTool();
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
    await expect(createTool().execute("oversized-metadata", {})).rejects.toThrow(
      "Session metadata exceeds the 64 KiB result budget",
    );
  });

  it("rejects invalid continuation metadata even when the output page is full", async () => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [sessionRow("agent:main:main", "main")],
      hasMore: true,
      nextOffset: 0,
    });
    await expect(createTool().execute("full-page-cursor", { limit: 1 })).rejects.toThrow(
      "sessions.list returned invalid pagination",
    );
  });

  it("does not advertise or silently ignore live-activity filtering in embedded mode", async () => {
    const tool = createSessionsListTool({ config: VALID_CONFIG, supportsActiveOnly: false });
    expect(tool.parameters).not.toHaveProperty("properties.activeOnly");
    await expect(tool.execute("embedded-activity", { activeOnly: true })).rejects.toThrow(
      "activeOnly requires a Gateway-backed inventory",
    );
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });

  it("does not broaden an empty explicit workspaceDir filter", async () => {
    const tool = createSessionsListTool({
      config: VALID_CONFIG,
      requesterProfileId: "profile-ada",
    });
    await expect(tool.execute("blank-filter", { workspaceDir: "  " })).rejects.toThrow("required");
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });

  it("deduplicates rows when a changing Gateway page overlaps the prior page", async () => {
    const first = sessionRow("agent:main:dashboard:first");
    const overlap = sessionRow("agent:main:dashboard:overlap");
    const finalRow = { ...first, key: "agent:main:dashboard:final" };
    mockSessionPages([
      [first, overlap],
      [overlap, finalRow],
    ]);

    const result = await createTool().execute("overlapping-list", { limit: 3 });
    const keys = sessionKeys(getSessionsListDetails(result)) ?? [];

    expect(keys).toEqual([first.key, overlap.key, finalRow.key]);
  });
});
