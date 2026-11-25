import { expect, it } from "vitest";
import { sharedModelAccountChoices } from "./shared-model-account-choices.ts";

it("uses the Gateway's stable ordinal only for the exact selectable runtime, model and provider", () => {
  const route = { provider: "minimax", id: "text", name: "Text" };
  const target = {
    provider: "minimax",
    model: "text",
    runtime: "openclaw",
    accounts: [{ profileId: "minimax:b@example.test", ordinal: 2 }, { profileId: "not/pinnable" }],
  };
  const status = { ts: 1, providers: [], accountTarget: target };
  expect(sharedModelAccountChoices(status, "minimax/text", route)).toMatchObject([
    { profileId: "minimax:b@example.test", label: "Shared account 2" },
  ]);
  for (const mismatch of [{ provider: "minimax-portal" }, { model: "other" }, { runtime: "cli" }]) {
    expect(
      sharedModelAccountChoices(
        { ...status, accountTarget: { ...target, ...mismatch } },
        "minimax/text",
        route,
      ),
    ).toEqual([]);
  }
});
