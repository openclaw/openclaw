import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { resolveSandboxRuntimeStatusAsync } from "../../agents/sandbox/runtime-status.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => null,
}));
vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));
vi.mock("../../infra/channel-summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/channel-summary.js")>()),
  buildChannelSummary: vi.fn(async () => [] as string[]),
}));
vi.mock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-catalog.js")>()),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.7", name: "M2.7" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-rollover-provenance-");

it("preserves an unqualified ACP parent agent through command-triggered daily rollover", async () => {
  const storePath = path.join(tempDirs.make(), "sessions.json");
  const sessionKey = "agent:main:acp:creator-audit";
  const stale = Date.now() - 48 * 60 * 60 * 1000;
  await writeSessionStoreFast(storePath, {
    [sessionKey]: {
      sessionId: "before-rollover",
      updatedAt: stale,
      sessionStartedAt: stale,
      lastInteractionAt: stale,
      createdVia: "spawn",
      createdActor: { type: "human", source: "profile", id: "alice" },
      createdAt: stale,
      sandbox: "required",
      sandboxProvenance: { actor: { type: "human", source: "profile", id: "isolation-bob" } },
      spawnedBy: "global",
      spawnedByAgentId: "main",
      spawnedBySessionId: "parent-generation",
    },
  });
  const result = await initSessionState({
    ctx: {
      RawBody: "/status",
      CommandBody: "/status",
      ChatType: "direct",
      SessionKey: sessionKey,
    },
    cfg: { session: { store: storePath, reset: { mode: "daily", atHour: 4 } } },
  });
  expect(result.isNewSession).toBe(true);
  expect(result.sessionEntry.sessionId).not.toBe("before-rollover");
  const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
  expect(persisted).toMatchObject({
    createdActor: { type: "human", source: "profile", id: "alice" },
    spawnedBy: "global",
    spawnedByAgentId: "main",
    spawnedBySessionId: "parent-generation",
    sandbox: "required",
    sandboxProvenance: { actor: { type: "human", source: "profile", id: "isolation-bob" } },
  });
  expect(
    (await resolveSandboxRuntimeStatusAsync({ cfg: { session: { store: storePath } }, sessionKey }))
      .isolationSubject,
  ).toEqual({ kind: "profile", profileId: "isolation-bob" });
});
