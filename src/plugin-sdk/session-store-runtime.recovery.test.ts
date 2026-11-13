import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type {
  InternalSessionEntry,
  SessionEntry as ConfigSessionEntry,
} from "../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-session-recovery-");
const publicPendingProjectIsPrivate: "pendingProjectGitUrl" extends keyof SessionEntry
  ? false
  : true = true;
const configPendingProjectIsPrivate: "pendingProjectGitUrl" extends keyof ConfigSessionEntry
  ? false
  : true = true;
void publicPendingProjectIsPrivate;
void configPendingProjectIsPrivate;

describe("session-store-runtime recovery boundary", () => {
  let scope: { sessionKey: string; storePath: string };
  const read = () => loadInternalSessionEntry(scope);
  beforeEach(() => {
    scope = {
      sessionKey: "agent:main:recovery",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
  });

  it("allows ordinary public run status to change without an active core transaction", async () => {
    await upsertSessionEntry({
      ...scope,
      agentId: "main",
      entry: { sessionId: "healthy-session", updatedAt: 10 },
    });

    await patchSessionEntry({
      ...scope,
      update: () => ({
        abortedLastRun: true,
      }),
    });

    expect(read()).toMatchObject({
      abortedLastRun: true,
      sessionId: "healthy-session",
    });
  });

  it("keeps pending remote-project recovery private across public session mutations", async () => {
    const pendingProjectGitUrl = "https://github.com/openclaw/openclaw.git";
    await replaceInternalSessionEntry(scope, {
      pendingProjectGitUrl,
      sessionId: "project-session",
      updatedAt: 10,
    });

    expect(getSessionEntry(scope)).not.toHaveProperty("pendingProjectGitUrl");
    expect(listSessionEntries(scope)[0]?.entry).not.toHaveProperty("pendingProjectGitUrl");

    for (const [mutate, model] of [
      [patchSessionEntry, "gpt-5.5"],
      [updateSessionStoreEntry, "gpt-5.6"],
    ] as const) {
      await mutate({ ...scope, update: () => ({ model }) });
      expect(read()).toMatchObject({ model, pendingProjectGitUrl });
    }

    await upsertSessionEntry({
      entry: { sessionId: "project-session", updatedAt: 20 },
      ...scope,
    });
    expect(read()?.pendingProjectGitUrl).toBe(pendingProjectGitUrl);

    await patchSessionEntry({
      replaceEntry: true,
      ...scope,
      update: () => ({ sessionId: "replacement-session", updatedAt: 30 }),
    });
    expect(read()).not.toHaveProperty("pendingProjectGitUrl");
  });

  it("rejects private shutdown state from runtime-escaped creation inputs", async () => {
    const injected = {
      resumeAfterRestart: { queuedInputIds: [] },
      pendingProjectGitUrl: "https://github.com/openclaw/injected.git",
      sessionId: "created",
      updatedAt: 10,
    } satisfies InternalSessionEntry;
    const expectPrivateFieldsRemoved = () => {
      expect(read()).not.toHaveProperty("resumeAfterRestart");
      expect(read()).not.toHaveProperty("pendingProjectGitUrl");
    };
    await patchSessionEntry({
      ...scope,
      fallbackEntry: injected,
      update: () => ({ updatedAt: 20 }),
    });
    expectPrivateFieldsRemoved();

    scope = { ...scope, sessionKey: "agent:main:upsert-created" };
    await upsertSessionEntry({ ...scope, entry: injected });
    expectPrivateFieldsRemoved();
  });
});
