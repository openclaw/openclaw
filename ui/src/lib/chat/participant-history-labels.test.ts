import { expect, it, vi } from "vitest";
import { withParticipantHistoryLabels } from "./participant-history-labels.ts";
it("recovers only an exact source from loaded user messages without granting a profile", () => {
  const identity = {
    type: "observation",
    pluginId: "discord",
    accountId: "one",
    senderKind: "human",
    id: "123",
  } as const;
  const participants = [
    { identity },
    { identity: { ...identity, accountId: "two" } },
    { identity: { type: "legacy", actorType: "human", source: "channel", id: "123" } as const },
  ];
  const message = (name: string) => ({
    role: "user",
    __openclaw: { senderName: name, senderId: "123", senderIdentity: identity },
  });
  expect(
    withParticipantHistoryLabels(participants, () => [
      message("First"),
      message("Last"),
      { ...message("Not a sender"), role: "assistant" },
      {
        ...message("Not bound"),
        __openclaw: { ...message("Not bound").__openclaw, senderId: "other" },
      },
    ]),
  ).toEqual([{ identity, label: "Last" }, ...participants.slice(1)]);
  const named = [{ identity, label: "Stored name" }];
  const read = vi.fn(() => []);
  expect(withParticipantHistoryLabels(named, read)).toBe(named);
  expect(read).not.toHaveBeenCalled();
});
