import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runStartupMatrixMigrationMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./server-startup-matrix-migration.js", () => ({
  runStartupMatrixMigration: runStartupMatrixMigrationMock,
}));

import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway startup Matrix migration wiring", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  beforeAll(async () => {
    testState.channelsConfig = {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
    };
    server = await startGatewayServer(await getFreePort());
  });

  afterAll(async () => {
    await server?.close();
  });

  it("runs startup Matrix migration with the resolved startup config", () => {
    expect(runStartupMatrixMigrationMock).toHaveBeenCalledTimes(1);
    expect(runStartupMatrixMigrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            matrix: expect.objectContaining({
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            }),
          }),
        }),
        env: process.env,
        log: expect.anything(),
      }),
    );
  });
});
