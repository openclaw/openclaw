import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./registry.js", () => ({ withFleetCellOperationLease: acquire }));

import { resolveControlUiAllowedOrigins } from "../config/gateway-control-ui-origins.js";
import { checkBrowserOrigin } from "../gateway/origin-check.js";
import { prepareCellConfig, withFleetCellOperation } from "./service-support.runtime.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("fleet operation lifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { allowedOrigins: undefined },
    { allowedOrigins: [] },
    { allowedOrigins: ["https://admin.example.com"] },
  ])(
    "admits published container origins and inherits public origin only when omitted (%j)",
    async ({ allowedOrigins }) => {
      const dataDir = tempDirs.make("fleet-origin-");
      const configPath = path.join(dataDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            publicOrigin: "https://TEAM.example.com:443/",
            controlUi: { allowedOrigins },
          },
        }),
      );
      await prepareCellConfig({
        tenantId: "team",
        createdAtMs: 1,
        image: "openclaw:test",
        runtime: "docker",
        hostPort: 19100,
        containerName: "openclaw-cell-team",
        dataDir,
      });
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(config.gateway.publicOrigin).toBe("https://TEAM.example.com:443/");
      expect(config.gateway.controlUi.allowedOrigins).toEqual(
        allowedOrigins === undefined
          ? ["https://team.example.com", "http://localhost:19100", "http://127.0.0.1:19100"]
          : [...allowedOrigins, "http://localhost:19100", "http://127.0.0.1:19100"],
      );
      for (const origin of [
        "http://localhost:19100",
        "http://127.0.0.1:19100",
        "https://team.example.com",
        "https://unrelated.example.com",
      ]) {
        expect(
          checkBrowserOrigin({
            origin,
            requestHost: "localhost:19100",
            isLocalClient: false,
            allowedOrigins: resolveControlUiAllowedOrigins(config),
          }).ok,
        ).toBe(
          origin.startsWith("http://") ||
            (origin === "https://team.example.com" && allowedOrigins === undefined),
        );
      }
      expect(config.gateway.auth).toEqual({ mode: "token" });
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
