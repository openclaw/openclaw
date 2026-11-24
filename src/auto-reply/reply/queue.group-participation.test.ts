import { expect, it } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupQueue } from "./queue/state.js";
import type { InternalFollowupRun } from "./queue/types.js";

it("keeps a collected mentioned request on the ordinary reply path", async () => {
  const queue = createQueueCase();
  const mentioned = createQueueTestRun({ prompt: "Agent, which port should I use?" });
  const chatter: InternalFollowupRun = {
    ...createQueueTestRun({ prompt: "Bob, see you at lunch." }),
    groupParticipation: {},
  };
  try {
    queue.add(mentioned);
    queue.add(chatter);
    await queue.drain();
    expect(queue.calls).toHaveLength(1);
    const collected: InternalFollowupRun = queue.calls[0]!;
    expect(collected.prompt).toContain(mentioned.prompt);
    expect(collected.prompt).toContain(chatter.prompt);
    expect(collected.groupParticipation).toBeUndefined();
  } finally {
    clearFollowupQueue(queue.key);
  }
});
