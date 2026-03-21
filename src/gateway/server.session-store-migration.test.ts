import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgentSessionDirsMock: vi
    .fn()
    .mockResolvedValue([
      "/tmp/openclaw/agents/main/sessions",
      "/tmp/openclaw/agents/worker/sessions",
    ]),
  migrateSessionStoreToDirectoryMock: vi.fn().mockResolvedValue(false),
}));

vi.mock("../commands/cleanup-utils.js", () => ({
  listAgentSessionDirs: mocks.listAgentSessionDirsMock,
}));

vi.mock("../config/sessions/store.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions/store.js")>(
    "../config/sessions/store.js",
  );
  return {
    ...actual,
    migrateSessionStoreToDirectory: mocks.migrateSessionStoreToDirectoryMock,
  };
});

import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway startup session-store migration wiring", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  beforeAll(async () => {
    testState.sessionConfig = {
      store: "/custom/openclaw/{agentId}/sessions.json",
    };
    server = await startGatewayServer(await getFreePort());
  });

  afterAll(async () => {
    await server?.close();
  });

  it("migrates discovered stores and the configured session store path", () => {
    expect(mocks.listAgentSessionDirsMock).toHaveBeenCalledTimes(1);
    expect(mocks.migrateSessionStoreToDirectoryMock).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/main/sessions/sessions.json",
    );
    expect(mocks.migrateSessionStoreToDirectoryMock).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/worker/sessions/sessions.json",
    );
    expect(mocks.migrateSessionStoreToDirectoryMock).toHaveBeenCalledWith(
      "/custom/openclaw/main/sessions.json",
    );
  });
});
