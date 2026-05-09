import { beforeEach, describe, expect, it, vi } from "vitest";

const readCronRunLogEntriesPageAllMock = vi.hoisted(() => vi.fn());

vi.mock("../../cron/run-log.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../cron/run-log.js")>("../../cron/run-log.js");
  return {
    ...actual,
    readCronRunLogEntriesPageAll: readCronRunLogEntriesPageAllMock,
  };
});

describe("cron.runs server method", () => {
  beforeEach(() => {
    readCronRunLogEntriesPageAllMock.mockReset();
  });

  it("builds all-scope job names from agent-scoped cron list pages", async () => {
    const { cronHandlers } = await import("./cron.js");
    const list = vi.fn();
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [{ id: "main-job", name: "visible main job" }],
        total: 2,
        offset: 0,
        limit: 1,
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        jobs: [{ id: "main-disabled-job", name: "visible disabled job" }],
        total: 2,
        offset: 1,
        limit: 1,
        hasMore: false,
        nextOffset: null,
      });
    readCronRunLogEntriesPageAllMock.mockResolvedValueOnce({
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    });
    const respond = vi.fn();

    await cronHandlers["cron.runs"]({
      req: {} as never,
      params: { scope: "all", agentId: "main", query: "visible", limit: 50 },
      respond,
      context: {
        cron: {
          list,
          listPage,
          getDefaultAgentId: vi.fn(() => "ops"),
        },
        cronStorePath: "/tmp/openclaw-cron/jobs.json",
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(list).not.toHaveBeenCalled();
    expect(listPage).toHaveBeenNthCalledWith(1, {
      includeDisabled: true,
      agentId: "main",
      limit: 200,
      offset: 0,
    });
    expect(listPage).toHaveBeenNthCalledWith(2, {
      includeDisabled: true,
      agentId: "main",
      limit: 200,
      offset: 1,
    });
    expect(readCronRunLogEntriesPageAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/openclaw-cron/jobs.json",
        query: "visible",
        jobNameById: {
          "main-job": "visible main job",
          "main-disabled-job": "visible disabled job",
        },
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        entries: [],
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
      undefined,
    );
  });

  it("defaults all-scope job-name lookup to the default agent", async () => {
    const { cronHandlers } = await import("./cron.js");
    const listPage = vi.fn().mockResolvedValueOnce({
      jobs: [{ id: "default-job", name: "default agent job" }],
      total: 1,
      offset: 0,
      limit: 1,
      hasMore: false,
      nextOffset: null,
    });
    readCronRunLogEntriesPageAllMock.mockResolvedValueOnce({
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    });

    await cronHandlers["cron.runs"]({
      req: {} as never,
      params: { scope: "all" },
      respond: vi.fn(),
      context: {
        cron: {
          listPage,
          getDefaultAgentId: vi.fn(() => "ops"),
        },
        cronStorePath: "/tmp/openclaw-cron/jobs.json",
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(listPage).toHaveBeenCalledWith({
      includeDisabled: true,
      agentId: "ops",
      limit: 200,
      offset: 0,
    });
    expect(readCronRunLogEntriesPageAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobNameById: {
          "default-job": "default agent job",
        },
      }),
    );
  });
});
