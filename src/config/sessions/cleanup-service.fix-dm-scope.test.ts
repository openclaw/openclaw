import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { replaceSessionEntry } from "./session-accessor.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cleanup-fix-dm-scope-");

it("retires only direct rows that no route binding still scopes per peer", async () => {
  const storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
  const keys = {
    boundChannel: "agent:main:telegram:direct:123",
    boundAccount: "agent:main:slack:work:direct:u1",
    boundPeer: "agent:main:direct:alice",
    otherAgentBinding: "agent:main:discord:direct:456",
    otherAccount: "agent:main:slack:home:direct:u2",
  };
  for (const [sessionId, sessionKey] of Object.entries(keys)) {
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey, sessionId },
      { sessionId, updatedAt: Date.now() },
    );
  }
  const cfg: OpenClawConfig = {
    bindings: [
      { agentId: "main", match: { channel: "Telegram" }, session: { dmScope: "per-channel-peer" } },
      {
        agentId: "main",
        match: { channel: "slack", accountId: "work" },
        session: { dmScope: "per-account-channel-peer" },
      },
      { agentId: "main", match: { channel: "signal" }, session: { dmScope: "per-peer" } },
      { agentId: "ops", match: { channel: "discord" }, session: { dmScope: "per-channel-peer" } },
    ],
  };

  const result = await runSessionsCleanup({
    cfg,
    opts: { dryRun: true, fixDmScope: true },
    targets: [{ agentId: "main", storePath }],
  });

  expect([...(result.previewResults[0]?.dmScopeRetiredKeys ?? [])].toSorted()).toEqual(
    [keys.otherAccount, keys.otherAgentBinding].toSorted(),
  );
});
