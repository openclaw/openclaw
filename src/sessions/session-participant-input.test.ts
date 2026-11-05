import { expect, it } from "vitest";
import {
  isSessionPersonalBootstrapTurn,
  prepareSessionParticipantInput,
  type SessionParticipantInputContext,
} from "./session-participant-input.js";

it("uses the session selection for qualified humans and internal continuations only", () => {
  const human: SessionParticipantInputContext = {};
  prepareSessionParticipantInput(human, { type: "profile", id: "participant" });
  for (const ctx of [
    human,
    { InputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" } },
    { InputProvenance: { kind: "internal_system", sourceTool: "goal_continue" } },
    { InternalTurnSource: "cron", SessionKey: "agent:main:conversation" },
  ] satisfies SessionParticipantInputContext[]) {
    expect(isSessionPersonalBootstrapTurn(ctx)).toBe(true);
  }
  expect(
    isSessionPersonalBootstrapTurn({
      ChatType: "group",
      SenderId: "unqualified-participant",
      InputProvenance: { kind: "external_user" },
    }),
  ).toBe(false);
  expect(
    isSessionPersonalBootstrapTurn({
      SessionKey: "agent:main:cron:isolated:run:synthetic",
      InputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    }),
  ).toBe(false);
});
