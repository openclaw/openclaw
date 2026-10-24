import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  recordInboundSessionMeta,
} from "../../config/sessions/session-accessor.js";
import { resolveGatewaySessionDisplayName } from "../../gateway/session-utils-display.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));
vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => null,
}));
vi.mock("../../infra/channel-summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/channel-summary.js")>()),
  buildChannelSummary: vi.fn(async () => []),
}));
vi.mock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-catalog.js")>()),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => []),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it.each([undefined, "New Chat"])(
  "keeps private Telegram topic titles visible across first reply initialization (cached: %s)",
  async (cachedDisplayName) => {
    const stateDir = tempDirs.make("openclaw-private-topic-first-reply-");
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:main:thread:42001:77";
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: "private-topic-first-reply",
          updatedAt: Date.now(),
          ...(cachedDisplayName ? { displayName: cachedDisplayName } : {}),
        },
      });
      const ctx = {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        From: "telegram:direct:42001",
        To: "telegram:42001",
        AccountId: "default",
        MessageThreadId: "77",
        SessionKey: sessionKey,
      };
      for (const title of ["Test 4", "Test 5"]) {
        const updated = await recordInboundSessionMeta({
          storePath,
          sessionKey,
          ctx: { ...ctx, ThreadLabel: title },
          createIfMissing: false,
        });
        expect(resolveGatewaySessionDisplayName(sessionKey, updated ?? undefined)).toBe(title);
        expect(updated?.sessionId).toBe("private-topic-first-reply");
      }

      const initialized = await initSessionState({
        ctx: { ...ctx, ThreadLabel: "Test 5", Body: "Hello", RawBody: "Hello" },
        cfg: { session: { store: storePath } },
      });
      expect(initialized.sessionEntry.displayName).toBe(cachedDisplayName ?? "Test 5");
      expect(resolveGatewaySessionDisplayName(sessionKey, initialized.sessionEntry)).toBe("Test 5");
      await appendTranscriptMessage(
        {
          agentId: "main",
          storePath,
          sessionKey,
          sessionId: initialized.sessionId,
        },
        { message: { role: "assistant", content: "Hello back" } },
      );
      const beforeRename = loadSessionEntry({ storePath, sessionKey });

      await recordInboundSessionMeta({
        storePath,
        sessionKey,
        ctx: { ...ctx, ThreadLabel: undefined },
        createIfMissing: false,
      });
      const afterReplyMetadata = loadSessionEntry({ storePath, sessionKey });
      expect(afterReplyMetadata?.sessionId).toBe("private-topic-first-reply");
      expect(afterReplyMetadata?.updatedAt).toBe(beforeRename?.updatedAt);
      expect(resolveGatewaySessionDisplayName(sessionKey, afterReplyMetadata ?? undefined)).toBe(
        "Test 5",
      );
    });
  },
);
