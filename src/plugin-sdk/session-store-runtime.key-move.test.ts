import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { updateSessionStore } from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-store-runtime whole-store key moves", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-sdk-session-key-move-"), "sessions.json");
  });

  it("preserves active recovery when a unique session identity moves keys", async () => {
    const oldKey = "agent:main:telegram:direct:old";
    const newKey = "agent:main:telegram:direct:new";
    const mainRestartRecovery = {
      chargedAttempts: 2,
      cycleId: "key-move-cycle",
      revision: 4,
    };
    await replaceInternalSessionEntry({ agentId: "main", sessionKey: oldKey, storePath }, {
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryRuns: [{ lifecycleGeneration: "key-move-generation", runId: "key-move-run" }],
      sessionId: "key-move-session",
      updatedAt: 10,
    } as InternalSessionEntry);

    await updateSessionStore(
      storePath,
      (store) => {
        store[newKey] = store[oldKey]!;
        delete store[oldKey];
      },
      { skipMaintenance: true },
    );

    expect(
      loadInternalSessionEntry({ agentId: "main", sessionKey: oldKey, storePath }),
    ).toBeUndefined();
    expect(
      loadInternalSessionEntry({ agentId: "main", sessionKey: newKey, storePath }),
    ).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryRuns: [{ lifecycleGeneration: "key-move-generation", runId: "key-move-run" }],
      sessionId: "key-move-session",
    });
  });

  it("does not duplicate private recovery across ambiguous move destinations", async () => {
    const oldKey = "agent:main:telegram:direct:old";
    const firstNewKey = "agent:main:telegram:direct:new-a";
    const secondNewKey = "agent:main:telegram:direct:new-b";
    await replaceInternalSessionEntry({ agentId: "main", sessionKey: oldKey, storePath }, {
      abortedLastRun: true,
      mainRestartRecovery: {
        chargedAttempts: 2,
        cycleId: "ambiguous-key-move-cycle",
        revision: 4,
      },
      sessionId: "ambiguous-key-move-session",
      updatedAt: 10,
    } as InternalSessionEntry);

    await updateSessionStore(
      storePath,
      (store) => {
        store[firstNewKey] = { ...store[oldKey]! };
        store[secondNewKey] = { ...store[oldKey]! };
        delete store[oldKey];
      },
      { skipMaintenance: true },
    );

    for (const sessionKey of [firstNewKey, secondNewKey]) {
      expect(
        loadInternalSessionEntry({ agentId: "main", sessionKey, storePath }),
      ).not.toHaveProperty("mainRestartRecovery");
    }
  });
});
