import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./registry.js", () => ({ withFleetCellOperationLease: acquire }));

import { prepareCellConfig, withFleetCellOperation } from "./service-support.runtime.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fleet operation lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { controlUi: undefined },
    { controlUi: {} },
    { controlUi: { allowedOrigins: [] } },
    { controlUi: { allowedOrigins: ["https://admin.example.com"] } },
    { controlUi: { allowedOrigins: ["http://localhost:19100", "http://127.0.0.1:19100"] } },
  ])(
    "preserves authored origins and omission through cell preparation and public-origin rotation (%j)",
    async ({ controlUi }) => {
      const dataDir = tempDirs.make("fleet-origin-");
      const configPath = path.join(dataDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            publicOrigin: "https://TEAM.example.com:443/",
            controlUi,
          },
        }),
      );
      const record = {
        tenantId: "team",
        createdAtMs: 1,
        image: "openclaw:test",
        runtime: "docker" as const,
        hostPort: 19100,
        containerName: "openclaw-cell-team",
        dataDir,
      };
      await prepareCellConfig(record);
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(config.gateway.publicOrigin).toBe("https://TEAM.example.com:443/");
      expect(config.gateway.controlUi).toEqual(controlUi);
      expect(config.gateway.auth).toEqual({ mode: "token" });

      config.gateway.publicOrigin = "https://rotated.example.com";
      await fs.writeFile(configPath, JSON.stringify(config));
      await prepareCellConfig({ ...record, hostPort: 19200 });
      const rotatedBytes = await fs.readFile(configPath, "utf8");
      const rotated = JSON.parse(rotatedBytes);
      expect(rotated.gateway.publicOrigin).toBe("https://rotated.example.com");
      expect(rotated.gateway.controlUi).toEqual(controlUi);
      await prepareCellConfig({ ...record, hostPort: 19200 });
      expect(await fs.readFile(configPath, "utf8")).toBe(rotatedBytes);
    },
  );

  it("awaits acquisition, checkpoints, timer renewal, and release before reporting success", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    acquire.mockImplementation(async (_params, operation) => {
      await Promise.resolve();
      events.push("acquired");
      const lease = {
        owner: "fixture-owner",
        heartbeat: async () => {
          await Promise.resolve();
          events.push("renewed");
        },
        release: async () => {
          await Promise.resolve();
          events.push("released");
        },
      };
      try {
        return await operation(lease);
      } finally {
        await lease.release();
      }
    });

    const result = await withFleetCellOperation({
      env: {},
      tenantId: "fixture",
      operationName: "start",
      operation: async (checkpoint) => {
        await checkpoint();
        events.push("effect");
        await vi.advanceTimersByTimeAsync(60_000);
        events.push("completed");
        return "started";
      },
    });

    expect(result).toBe("started");
    expect(events).toEqual([
      "acquired",
      "renewed",
      "effect",
      "renewed",
      "completed",
      "renewed",
      "released",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
