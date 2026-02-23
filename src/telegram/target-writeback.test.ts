import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const readConfigFileSnapshotForWrite = vi.fn();
const writeConfigFile = vi.fn();
const loadCronStore = vi.fn();
const resolveCronStorePath = vi.fn();
const saveCronStore = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
});

vi.mock("../cron/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/store.js")>();
  return {
    ...actual,
    loadCronStore,
    resolveCronStorePath,
    saveCronStore,
  };
});

const { maybePersistResolvedTelegramTarget } = await import("./target-writeback.js");

describe("maybePersistResolvedTelegramTarget", () => {
  beforeEach(() => {
    readConfigFileSnapshotForWrite.mockReset();
    writeConfigFile.mockReset();
    loadCronStore.mockReset();
    resolveCronStorePath.mockReset();
    saveCronStore.mockReset();
    resolveCronStorePath.mockReturnValue("/tmp/cron/jobs.json");
  });

  it("skips writeback when target is already numeric", async () => {
    await maybePersistResolvedTelegramTarget({
      cfg: {} as OpenClawConfig,
      rawTarget: "-100123",
      resolvedChatId: "-100123",
    });

    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(loadCronStore).not.toHaveBeenCalled();
  });

  it("writes back matching config and cron targets", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              defaultTo: "t.me/mychannel",
              accounts: {
                alerts: {
                  defaultTo: "@mychannel",
                },
              },
            },
          },
        },
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    loadCronStore.mockResolvedValue({
      version: 1,
      jobs: [
        { id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } },
        { id: "b", delivery: { channel: "slack", to: "C123" } },
      ],
    });

    await maybePersistResolvedTelegramTarget({
      cfg: {
        cron: { store: "/tmp/cron/jobs.json" },
      } as OpenClawConfig,
      rawTarget: "t.me/mychannel",
      resolvedChatId: "-100123",
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          telegram: {
            defaultTo: "-100123",
            accounts: {
              alerts: {
                defaultTo: "-100123",
              },
            },
          },
        },
      }),
      expect.objectContaining({ expectedConfigPath: "/tmp/openclaw.json" }),
    );
    expect(saveCronStore).toHaveBeenCalledTimes(1);
    expect(saveCronStore).toHaveBeenCalledWith(
      "/tmp/cron/jobs.json",
      expect.objectContaining({
        jobs: [
          { id: "a", delivery: { channel: "telegram", to: "-100123" } },
          { id: "b", delivery: { channel: "slack", to: "C123" } },
        ],
      }),
    );
  });

  it("preserves topic suffix style in writeback target", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        config: {
          channels: {
            telegram: {
              defaultTo: "t.me/mychannel:topic:9",
            },
          },
        },
      },
      writeOptions: {},
    });
    loadCronStore.mockResolvedValue({ version: 1, jobs: [] });

    await maybePersistResolvedTelegramTarget({
      cfg: {} as OpenClawConfig,
      rawTarget: "t.me/mychannel:topic:9",
      resolvedChatId: "-100123",
    });

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          telegram: {
            defaultTo: "-100123:topic:9",
          },
        },
      }),
      expect.any(Object),
    );
  });
});
