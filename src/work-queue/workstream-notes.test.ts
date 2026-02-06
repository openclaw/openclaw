import { describe, expect, it } from "vitest";
import { MemoryWorkstreamNotesBackend, WorkstreamNotesStore } from "./workstream-notes.js";

describe("WorkstreamNotesStore", () => {
  function createStore() {
    return new WorkstreamNotesStore(new MemoryWorkstreamNotesBackend());
  }

  it("appends and retrieves notes", () => {
    const store = createStore();
    const note = store.append({
      workstream: "feature-dev",
      kind: "finding",
      content: "Auth uses JWT tokens",
      createdBy: { agentId: "worker-1" },
    });

    expect(note.id).toBeDefined();
    expect(note.createdAt).toBeDefined();
    expect(note.workstream).toBe("feature-dev");
    expect(note.kind).toBe("finding");

    const notes = store.list("feature-dev");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("Auth uses JWT tokens");
  });

  it("lists notes filtered by kind", () => {
    const store = createStore();
    store.append({ workstream: "ws", kind: "finding", content: "Finding 1" });
    store.append({ workstream: "ws", kind: "decision", content: "Decision 1" });
    store.append({ workstream: "ws", kind: "finding", content: "Finding 2" });

    const findings = store.list("ws", { kind: "finding" });
    expect(findings).toHaveLength(2);
    expect(findings.every((n) => n.kind === "finding")).toBe(true);

    const decisions = store.list("ws", { kind: "decision" });
    expect(decisions).toHaveLength(1);
  });

  it("lists notes by item ID", () => {
    const store = createStore();
    store.append({ workstream: "ws", itemId: "item-1", kind: "context", content: "Note A" });
    store.append({ workstream: "ws", itemId: "item-2", kind: "context", content: "Note B" });
    store.append({ workstream: "ws", itemId: "item-1", kind: "finding", content: "Note C" });

    const itemNotes = store.listByItem("item-1");
    expect(itemNotes).toHaveLength(2);
  });

  it("returns notes newest first", async () => {
    const store = createStore();
    store.append({ workstream: "ws", kind: "finding", content: "First" });
    // Ensure different timestamps.
    await new Promise((r) => setTimeout(r, 5));
    store.append({ workstream: "ws", kind: "finding", content: "Second" });

    const notes = store.list("ws");
    expect(notes[0]!.content).toBe("Second");
    expect(notes[1]!.content).toBe("First");
  });

  it("prunes old notes beyond cap", () => {
    const store = createStore();
    for (let i = 0; i < 10; i++) {
      store.append({ workstream: "ws", kind: "context", content: `Note ${i}` });
    }

    const pruned = store.prune("ws", 5);
    expect(pruned).toBe(5);

    const remaining = store.list("ws");
    expect(remaining).toHaveLength(5);
  });

  it("summarize formats notes compactly", () => {
    const store = createStore();
    store.append({
      workstream: "feature-dev",
      itemId: "abc12345-xxxx",
      kind: "finding",
      content: "JWT tokens stored in Redis",
    });
    store.append({
      workstream: "feature-dev",
      kind: "decision",
      content: "Using Passport.js for auth",
    });

    const notes = store.list("feature-dev");
    const summary = store.summarize(notes);

    expect(summary).toContain("## Workstream Notes (feature-dev)");
    expect(summary).toContain("finding");
    expect(summary).toContain("decision");
    expect(summary).toContain("JWT tokens stored in Redis");
  });

  it("summarize respects maxChars limit", () => {
    const store = createStore();
    for (let i = 0; i < 20; i++) {
      store.append({
        workstream: "ws",
        kind: "context",
        content: `This is a note with some content about topic number ${i}`,
      });
    }

    const notes = store.list("ws");
    const summary = store.summarize(notes, { maxChars: 200 });
    expect(summary.length).toBeLessThanOrEqual(250); // Some slack for the header
  });

  it("summarize returns empty string for no notes", () => {
    const store = createStore();
    expect(store.summarize([])).toBe("");
  });

  it("auto-prunes on append when exceeding default cap", () => {
    const backend = new MemoryWorkstreamNotesBackend();
    const store = new WorkstreamNotesStore(backend);

    // Append 35 notes (default cap is 30).
    for (let i = 0; i < 35; i++) {
      store.append({ workstream: "ws", kind: "context", content: `Note ${i}` });
    }

    const notes = store.list("ws", { limit: 100 });
    expect(notes.length).toBeLessThanOrEqual(30);
  });
});
