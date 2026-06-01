import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { persistAbortTargetEntry, persistSessionEntry } from "./commands-session-store.js";

function createEntry(): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: 1,
  };
}

describe("command session metadata notifications", () => {
  it("derives metadata agentId from agent-scoped session keys", async () => {
    const entry = createEntry();
    const sessionStore: Record<string, SessionEntry> = {};
    const onSessionMetadataChanged = vi.fn();

    await persistSessionEntry({
      sessionKey: "agent:target:telegram:direct:123",
      agentId: "main",
      sessionEntry: entry,
      sessionStore,
      opts: { onSessionMetadataChanged },
    } as never);

    expect(onSessionMetadataChanged).toHaveBeenCalledWith({
      sessionKey: "agent:target:telegram:direct:123",
      agentId: "target",
      reason: "command-metadata",
    });
  });

  it("keeps fallback agentId only for global session metadata", async () => {
    const entry = createEntry();
    const sessionStore: Record<string, SessionEntry> = {};
    const onSessionMetadataChanged = vi.fn();

    await persistSessionEntry({
      sessionKey: "global",
      agentId: "target",
      sessionEntry: entry,
      sessionStore,
      opts: { onSessionMetadataChanged },
    } as never);

    expect(onSessionMetadataChanged).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "target",
      reason: "command-metadata",
    });
  });

  it("canonicalizes scoped global metadata to the global row and parsed agent", async () => {
    const entry = createEntry();
    const sessionStore: Record<string, SessionEntry> = {};
    const onSessionMetadataChanged = vi.fn();

    await persistSessionEntry({
      sessionKey: "agent:target:global",
      agentId: "main",
      sessionEntry: entry,
      sessionStore,
      opts: { onSessionMetadataChanged },
    } as never);

    expect(onSessionMetadataChanged).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "target",
      reason: "command-metadata",
    });
  });

  it("derives abort-target metadata agentId from the changed key", async () => {
    const entry = createEntry();
    const sessionStore: Record<string, SessionEntry> = {};
    const onSessionMetadataChanged = vi.fn();

    await persistAbortTargetEntry({
      key: "agent:target:telegram:direct:123",
      agentId: "main",
      entry,
      sessionStore,
      onSessionMetadataChanged,
    });

    expect(onSessionMetadataChanged).toHaveBeenCalledWith({
      sessionKey: "agent:target:telegram:direct:123",
      agentId: "target",
      reason: "command-metadata",
    });
  });
});
