import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AcpSessionManager } from "../acp/control-plane/manager.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getAcpSessionManager, readAcpSessionEntry, testing } from "./acp-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("acp-runtime session isolation", () => {
  let previousStateDir: string | undefined;
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-sdk-acp-runtime-");
    storePath = path.join(tempDir, "sessions.json");
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;
    testing.resetAcpSessionManagerForTests();
  });

  afterEach(() => {
    testing.resetAcpSessionManagerForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("hides private recovery while preserving the ACP manager class contract", async () => {
    const sessionKey = "agent:main:main";
    const cfg = {
      session: { store: storePath },
    } as NonNullable<Parameters<typeof readAcpSessionEntry>[0]["cfg"]>;
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "acp-cycle",
      revision: 1,
    };
    await replaceInternalSessionEntry({ sessionKey, storePath }, {
      mainRestartRecovery,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      sessionId: "acp-session",
      updatedAt: 10,
    } as InternalSessionEntry);
    await upsertAcpSessionMeta({
      cfg,
      sessionKey,
      now: () => 20,
      mutate: () => ({
        agent: "acp-agent",
        backend: "acp-backend",
        lastActivityAt: 20,
        mode: "persistent",
        runtimeSessionName: "acp-runtime-session",
        state: "idle",
      }),
    });

    const direct = readAcpSessionEntry({ cfg, sessionKey });
    const manager = getAcpSessionManager();
    const resolved = manager.resolveSession({ cfg, sessionKey });

    expect(direct?.entry).not.toHaveProperty("mainRestartRecovery");
    expect(direct?.entry).toHaveProperty("restartRecoveryDeliveryReceiptState", "terminal-pending");
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") {
      throw new Error("expected a ready ACP session");
    }
    expect(resolved.entry).not.toHaveProperty("mainRestartRecovery");
    expect(resolved.entry).toHaveProperty(
      "restartRecoveryDeliveryReceiptState",
      "terminal-pending",
    );
    expect(manager).toBeInstanceOf(AcpSessionManager);
    expect(Object.getPrototypeOf(manager)).toBe(AcpSessionManager.prototype);
    expect(manager.constructor).toBe(AcpSessionManager);
    expect(getAcpSessionManager()).toBe(manager);
    expect(Reflect.get(manager, "deps")).toBeUndefined();
    expect(Reflect.get(manager, "writeSessionMeta")).toBeUndefined();
    expect(manager.getObservabilitySnapshot(cfg).turns.active).toBe(0);

    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
    });
  });
});
