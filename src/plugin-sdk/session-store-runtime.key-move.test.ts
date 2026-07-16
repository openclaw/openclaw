import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InternalSessionEntry } from "../config/sessions/main-session-recovery.types.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import { reconcilePluginSessionStore } from "../plugins/runtime/session-store-facade.js";
import { updateSessionStore } from "./session-store-runtime.js";

describe("session-store-runtime whole-store key moves", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-key-move-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("preserves recovery when a unique session identity moves keys", async () => {
    const oldKey = "agent:main:telegram:direct:old";
    const newKey = "agent:main:telegram:direct:new";
    const mainRestartRecovery = {
      chargedAttempts: 2,
      cycleId: "key-move-cycle",
      revision: 4,
    };
    const restartRecoveryState = {
      restartRecoveryDeliveryReceiptState: "terminal-pending" as const,
      restartRecoveryDeliveryToolCallId: "message-call-key-move",
      restartRecoveryRequesterAccountId: "account-key-move",
      restartRecoverySourceIngress: "channel" as const,
    };
    await replaceInternalSessionEntry({ agentId: "main", sessionKey: oldKey, storePath }, {
      mainRestartRecovery,
      ...restartRecoveryState,
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
      mainRestartRecovery,
      ...restartRecoveryState,
      sessionId: "key-move-session",
    });
  });

  it("does not duplicate recovery across ambiguous move destinations", async () => {
    const oldKey = "agent:main:telegram:direct:old";
    const firstNewKey = "agent:main:telegram:direct:new-a";
    const secondNewKey = "agent:main:telegram:direct:new-b";
    await replaceInternalSessionEntry({ agentId: "main", sessionKey: oldKey, storePath }, {
      mainRestartRecovery: {
        chargedAttempts: 2,
        cycleId: "ambiguous-key-move-cycle",
        revision: 4,
      },
      restartRecoveryDeliveryReceiptState: "terminal-pending",
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

    expect(
      loadInternalSessionEntry({ agentId: "main", sessionKey: firstNewKey, storePath }),
    ).not.toHaveProperty("mainRestartRecovery");
    expect(
      loadInternalSessionEntry({ agentId: "main", sessionKey: secondNewKey, storePath }),
    ).not.toHaveProperty("mainRestartRecovery");
    expect(
      loadInternalSessionEntry({ agentId: "main", sessionKey: firstNewKey, storePath }),
    ).not.toHaveProperty("restartRecoveryDeliveryReceiptState");
    expect(
      loadInternalSessionEntry({ agentId: "main", sessionKey: secondNewKey, storePath }),
    ).not.toHaveProperty("restartRecoveryDeliveryReceiptState");
  });

  it("does not guess recovery across ambiguous source identities", () => {
    const firstOldKey = "agent:main:telegram:direct:old-a";
    const secondOldKey = "agent:main:telegram:direct:old-b";
    const newKey = "agent:main:telegram:direct:new";
    const sessionId = "ambiguous-source-session";
    const internalStore: Record<string, InternalSessionEntry> = {
      [firstOldKey]: {
        mainRestartRecovery: {
          chargedAttempts: 2,
          cycleId: "ambiguous-source-cycle",
          revision: 4,
        },
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        sessionId,
        updatedAt: 10,
      },
      [secondOldKey]: {
        sessionId,
        updatedAt: 20,
      },
    };
    const publicStore = {
      [newKey]: {
        sessionId,
        updatedAt: 10,
      },
    };

    reconcilePluginSessionStore({ internalStore, publicStore });

    expect(internalStore[newKey]).not.toHaveProperty("mainRestartRecovery");
    expect(internalStore[newKey]).not.toHaveProperty("restartRecoveryDeliveryReceiptState");
  });
});
