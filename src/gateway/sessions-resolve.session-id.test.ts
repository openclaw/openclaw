import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const storeState = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadCombinedSessionStoreForGatewayCore: () => ({
    store: storeState.store,
    targetsBySessionKey: new Map(),
  }),
}));

import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

describe("sessionId resolution", () => {
  it("filters unrelated entries before owner projection", async () => {
    const unrelated = {
      sessionId: "other-session",
      updatedAt: 2,
    } as SessionEntry;
    Object.defineProperty(unrelated, "owner", {
      get: () => {
        throw new Error("unrelated entry reached owner projection");
      },
    });
    storeState.store = {
      "agent:main:target": { sessionId: "target-session", updatedAt: 1 },
      "agent:main:unrelated": unrelated,
    };

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig,
        client: null,
        p: { agentId: "main", sessionId: "target-session" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      key: "agent:main:target",
      agentId: "main",
    });
  });
});
