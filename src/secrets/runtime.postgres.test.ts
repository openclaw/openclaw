import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_AGENT_DIR = path.resolve("/tmp/openclaw-agent-main");

const loadAuthProfileStoreSnapshotsFromPostgresMock = vi.hoisted(() =>
  vi.fn(async () => [] as Array<{ agentDir: string; store: Record<string, unknown> }>),
);

vi.mock("../persistence/service.js", () => ({
  loadAuthProfileStoreSnapshotsFromPostgres: loadAuthProfileStoreSnapshotsFromPostgresMock,
}));

import { prepareSecretsRuntimeSnapshot } from "./runtime.js";

describe("secrets runtime snapshot postgres auth loading", () => {
  afterEach(() => {
    loadAuthProfileStoreSnapshotsFromPostgresMock.mockReset();
    loadAuthProfileStoreSnapshotsFromPostgresMock.mockResolvedValue([]);
  });

  it("prefers postgres-backed auth stores when persistence backend is postgres", async () => {
    loadAuthProfileStoreSnapshotsFromPostgresMock.mockResolvedValue([
      {
        agentDir: TEST_AGENT_DIR,
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-postgres-runtime",
            },
          },
        },
      },
    ]);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {
        persistence: {
          backend: "postgres",
          postgres: {
            url: "postgresql://openclaw:test@localhost/openclaw",
          },
        },
      },
      agentDirs: [TEST_AGENT_DIR],
    });

    expect(loadAuthProfileStoreSnapshotsFromPostgresMock).toHaveBeenCalledWith({
      config: {
        persistence: {
          backend: "postgres",
          postgres: {
            url: "postgresql://openclaw:test@localhost/openclaw",
          },
        },
      },
      env: undefined,
      lookupMode: "runtime",
    });
    expect(snapshot.authStores).toEqual([
      {
        agentDir: TEST_AGENT_DIR,
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-postgres-runtime",
            },
          },
        },
      },
    ]);
  });
});
