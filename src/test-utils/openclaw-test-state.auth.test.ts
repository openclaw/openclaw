import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { withOpenClawTestState } from "./openclaw-test-state.js";

vi.mock("../plugins/loader-runtime-load.js", () => {
  throw new Error("Fixture auth seeding imported plugin runtime ownership");
});

it("seeds isolated auth credentials and usage without loading plugin runtime", async () => {
  await withOpenClawTestState({ label: "auth-seed" }, async (state) => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture:key": { type: "api_key", provider: "fixture", key: "synthetic-key" },
        "fixture:oauth": {
          type: "oauth",
          provider: "fixture",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 4_000_000_000_000,
        },
      },
      runtimeExternalProfileIds: ["fixture:oauth"],
      order: { fixture: ["fixture:oauth", "fixture:key"] },
      lastGood: { fixture: "fixture:key" },
      usageStats: { "fixture:key": { lastUsed: 42, errorCount: 1 } },
    };
    const profilePath = await state.writeAuthProfiles(store, "seeded");
    expect(profilePath).toBe(path.join(state.agentDir("seeded"), "openclaw-agent.sqlite"));
    expect(loadPersistedAuthProfileStore(state.agentDir("seeded"))).toMatchObject({
      version: store.version,
      profiles: store.profiles,
      order: store.order,
      lastGood: store.lastGood,
      usageStats: store.usageStats,
    });
    await state.writeAuthProfiles({ version: 1, profiles: {} }, "other");
    expect(loadPersistedAuthProfileStore(state.agentDir("other"))?.profiles).toEqual({});
    expect(loadPersistedAuthProfileStore(state.agentDir("seeded"))?.profiles).toEqual(
      store.profiles,
    );
  });
});
