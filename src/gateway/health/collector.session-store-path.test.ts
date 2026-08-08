// Health must report the SQLite store actually read, not the legacy sessions.json locator.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("buildHealthSessionSummary store path", () => {
  afterEach(() => {
    vi.doUnmock("../../config/sessions/session-accessor.js");
    vi.resetModules();
  });

  it("reports the resolved SQLite database path for the default agent layout", async () => {
    vi.doMock("../../config/sessions/session-accessor.js", () => ({
      listSessionEntriesReadOnly: () => [
        { sessionKey: "telegram:group:123", entry: { updatedAt: 1 } },
      ],
    }));
    const { buildHealthSessionSummary } = await import("./collector.js");

    const stateDir = path.join(path.sep, "tmp", "openclaw-health-test-state");
    const legacyStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const summary = await buildHealthSessionSummary(legacyStorePath, "main");

    expect(summary.path).toBe(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    expect(summary.count).toBe(1);
  });
});
