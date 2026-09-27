import { expect, it, vi } from "vitest";

vi.mock("./transcript.js", () => {
  throw new Error("Transcript routing must not initialize transcript storage");
});

it("resolves routing tokens and entries without loading transcript storage", async () => {
  const { resolveSessionTranscriptFile } = await import("./transcript-resolve.runtime.js");
  const sessionKey = "agent:main:test";
  const explicitEntry = { sessionId: "explicit-session", updatedAt: 1 };
  const storedEntry = { sessionId: "stored-session", updatedAt: 2 };
  const sessionStore = { [sessionKey]: storedEntry };

  for (const { sessionEntry, store, expectedEntry } of [
    { sessionEntry: explicitEntry, store: sessionStore, expectedEntry: explicitEntry },
    { sessionEntry: undefined, store: sessionStore, expectedEntry: storedEntry },
    { sessionEntry: undefined, store: undefined, expectedEntry: undefined },
  ]) {
    const resolved = await resolveSessionTranscriptFile({
      sessionId: "requested-session",
      sessionKey,
      sessionEntry,
      sessionStore: store,
      agentId: "main",
    });

    expect(resolved.sessionFile).toBe(sessionKey);
    expect(resolved.sessionEntry).toBe(expectedEntry);
  }
});
