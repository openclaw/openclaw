import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { ErrorCodes } from "./protocol/index.js";

const hoisted = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  listSessionsFromStoreMock: vi.fn(),
  migrateAndPruneGatewaySessionStoreKeyMock: vi.fn(),
  resolveGatewaySessionStoreTargetMock: vi.fn(),
}));

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    loadSessionStore: hoisted.loadSessionStoreMock,
    updateSessionStore: hoisted.updateSessionStoreMock,
  };
});

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    listSessionsFromStore: hoisted.listSessionsFromStoreMock,
    migrateAndPruneGatewaySessionStoreKey: hoisted.migrateAndPruneGatewaySessionStoreKeyMock,
    resolveGatewaySessionStoreTarget: hoisted.resolveGatewaySessionStoreTargetMock,
  };
});

const { resolveSessionKeyFromResolveParams } = await import("./sessions-resolve.js");

describe("resolveSessionKeyFromResolveParams", () => {
  const canonicalKey = "agent:main:canon";
  const legacyKey = "agent:main:legacy";
  const storePath = "/tmp/sessions.json";

  beforeEach(() => {
    hoisted.loadSessionStoreMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.listSessionsFromStoreMock.mockReset();
    hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReset();
    hoisted.resolveGatewaySessionStoreTargetMock.mockReset();
    hoisted.resolveGatewaySessionStoreTargetMock.mockReturnValue({
      canonicalKey,
      storeKeys: [canonicalKey, legacyKey],
      storePath,
    });
    hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReturnValue({ primaryKey: canonicalKey });
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_path: string, updater: (store: Record<string, SessionEntry>) => void) => {
        const store = hoisted.loadSessionStoreMock.mock.results[0]?.value as
          | Record<string, SessionEntry>
          | undefined;
        if (store) {
          updater(store);
        }
      },
    );
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
    });
    hoisted.listSessionsFromStoreMock.mockReturnValue({ sessions: [] });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${canonicalKey}`,
      },
    });
  });

  it("re-checks migrated legacy keys through the same visibility filter", async () => {
    const store = {
      [legacyKey]: { sessionId: "sess-legacy", updatedAt: 1 },
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.listSessionsFromStoreMock.mockReturnValue({
      sessions: [{ key: canonicalKey }],
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      key: canonicalKey,
    });

    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledWith(storePath, expect.any(Function));
    expect(hoisted.listSessionsFromStoreMock).toHaveBeenCalledWith({
      cfg: {},
      storePath,
      store,
      opts: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "controller-1",
        agentId: undefined,
      },
    });
  });
});
