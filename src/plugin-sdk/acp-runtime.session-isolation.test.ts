import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import type { InternalSessionEntry } from "../config/sessions/main-session-recovery.types.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import { getAcpSessionManager, readAcpSessionEntry, testing } from "./acp-runtime.js";

describe("acp-runtime session isolation", () => {
  let previousStateDir: string | undefined;
  let storePath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-acp-runtime-"));
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
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("hides core recovery state through ACP SDK entrypoints", async () => {
    const sessionKey = "agent:main:main";
    const cfg = {
      session: { store: storePath },
    } as NonNullable<Parameters<typeof readAcpSessionEntry>[0]["cfg"]>;
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "acp-cycle",
      reservation: {
        attempt: 1,
        lifecycleGeneration: "acp-generation",
        runId: "acp-run",
      },
      revision: 1,
    };
    await replaceInternalSessionEntry({ sessionKey, storePath }, {
      mainRestartRecovery,
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

    expect({
      directReadExposedPrivateState: Object.hasOwn(direct?.entry ?? {}, "mainRestartRecovery"),
      managerResolutionExposedPrivateState:
        resolved.kind === "ready" && Object.hasOwn(resolved.entry ?? {}, "mainRestartRecovery"),
      managerFacadeIsStable: getAcpSessionManager() === manager,
      boundManagerMethodWorks: manager.getObservabilitySnapshot(cfg).turns.active === 0,
    }).toEqual({
      directReadExposedPrivateState: false,
      managerResolutionExposedPrivateState: false,
      managerFacadeIsStable: true,
      boundManagerMethodWorks: true,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toEqual(
      mainRestartRecovery,
    );
  });
});
