import { describe, expect, it } from "vitest";
import { ExperientialStore } from "../../../experiential/store.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

describe("compaction-capture hook", () => {
  it("skips non-session events", async () => {
    const event = createHookEvent("command", "new", "agent:main:main", {});
    await handler(event);
  });

  it("skips non-compaction_summary actions", async () => {
    const event = createHookEvent("session", "start", "agent:main:main", {});
    await handler(event);
  });

  it("saves checkpoint on compaction_summary event", async () => {
    const summary = `# Session Summary
- Discussed API design patterns
- Decided to use REST over GraphQL
- Key: authentication flow needs review
- Will implement rate limiting next`;

    const event = createHookEvent("session", "compaction_summary", "agent:main:main", {
      summary,
      sessionId: "sess-123",
      sessionKey: "agent:main:main",
    });

    await handler(event);

    // Verify checkpoint was saved
    const store = new ExperientialStore();
    try {
      const checkpoint = store.getLatestCheckpoint();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.sessionKey).toBe("agent:main:main");
      expect(checkpoint!.trigger).toBe("compaction");
      expect(checkpoint!.keyContextSummary).toBe(summary);
      expect(checkpoint!.activeTopics.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("skips when explicitly disabled", async () => {
    const store = new ExperientialStore();
    const countBefore = store.getRecentCheckpoints(100).length;
    store.close();

    const event = createHookEvent("session", "compaction_summary", "agent:main:main", {
      summary: "test summary",
      cfg: {
        hooks: {
          internal: {
            entries: {
              "compaction-capture": { enabled: false },
            },
          },
        },
      },
    });

    await handler(event);

    const store2 = new ExperientialStore();
    const countAfter = store2.getRecentCheckpoints(100).length;
    store2.close();

    expect(countAfter).toBe(countBefore);
  });

  it("skips when summary is empty", async () => {
    const event = createHookEvent("session", "compaction_summary", "agent:main:main", {});
    // Should not throw
    await handler(event);
  });

  it("extracts conversation anchors from summary", async () => {
    const summary = `We decided to use TypeScript for the project.
The team agreed on a 2-week sprint cycle.
Key: database migration must happen before launch.
We will implement caching for frequently accessed data.`;

    const event = createHookEvent("session", "compaction_summary", "agent:test:anchors", {
      summary,
    });

    await handler(event);

    const store = new ExperientialStore();
    try {
      const checkpoints = store.getRecentCheckpoints(10);
      const found = checkpoints.find((cp) => cp.sessionKey === "agent:test:anchors");
      expect(found).toBeDefined();
      expect(found!.conversationAnchors.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
