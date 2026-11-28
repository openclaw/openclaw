import { expect, it } from "vitest";
import { buildRunEntrySelection } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

const selection = { cfg: {}, provider: "openai", model: "gpt-4.1" } as Parameters<
  typeof buildRunEntrySelection
>[0];

function scheduledRun(inferenceBinding?: { source: "user" | "auto"; profileId: string }) {
  return {
    authProfileId: "openai:session-choice",
    authProfileIdSource: "user",
    scheduledAutomation: { job: { inferenceBinding } },
  } as unknown as FollowupRun["run"];
}

// An unbound scheduled turn keeps the session's explicit account like an interactive turn (#202699).
it("locks an unbound scheduled turn to the session's explicit account", () => {
  expect(buildRunEntrySelection(selection, scheduledRun()).userLockedAuthProfileId).toBe(
    "openai:session-choice",
  );
});

it("locks a recorded scheduled turn only to an explicit recorded account", () => {
  expect(
    buildRunEntrySelection(selection, scheduledRun({ source: "user", profileId: "openai:pinned" }))
      .userLockedAuthProfileId,
  ).toBe("openai:pinned");
  expect(
    buildRunEntrySelection(selection, scheduledRun({ source: "auto", profileId: "openai:auto" }))
      .userLockedAuthProfileId,
  ).toBeUndefined();
});
