import { describe, expect, it } from "vitest";

import { createMSTeamsPollStoreMemory } from "./polls-store-memory.js";

describe("msteams poll memory store", () => {
  it("stores polls and records normalized votes", async () => {
    const store = createMSTeamsPollStoreMemory();
    await store.createPoll({
      id: "poll-1",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      createdAt: new Date().toISOString(),
      votes: {},
    });

    const poll = await store.recordVote({
      pollId: "poll-1",
      voterId: "user-1",
      selections: ["0", "1"],
    });

    expect(poll?.votes["user-1"]).toEqual(["0"]);
  });
});
