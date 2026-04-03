import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const runChannelPluginStartupMaintenanceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: runChannelPluginStartupMaintenanceMock,
}));

import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway startup channel maintenance wiring", () => {
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

  it("runs startup channel maintenance with the resolved startup config", () => {
    expect(runChannelPluginStartupMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runChannelPluginStartupMaintenanceMock).toHaveBeenCalledWith(
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
