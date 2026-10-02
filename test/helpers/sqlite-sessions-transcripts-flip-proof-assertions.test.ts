import { describe, expect, it } from "vitest";
import { withEnv } from "../../src/test-utils/env.js";
import { assertSqliteFlipStartupRefusal } from "./sqlite-sessions-transcripts-flip-proof-assertions.js";

function startupRefusal(command: string) {
  return {
    message: `gateway refused startup: legacy migration required (code=78 signal=null)
Legacy session store requires migration: /qa/state/agents/main/sessions/sessions.json. Run "${command}" against the same state/config before starting OpenClaw.`,
    preservedSourceFiles: [
      "agents/main/sessions/sessions.json",
      "agents/main/sessions/archive-fixture/cold-archive.jsonl",
      "agents/main/sessions/sqlite-legacy-main.jsonl",
    ],
  };
}

describe("SQLite flip proof startup refusal assertions", () => {
  it.each([
    { label: "unprofiled", profile: undefined, command: "openclaw doctor --fix" },
    {
      label: "profile-qualified",
      profile: "qa-sqlite-proof",
      command: "openclaw --profile qa-sqlite-proof doctor --fix",
    },
  ])("accepts $label guidance with preserved legacy sources", ({ profile, command }) => {
    withEnv({ OPENCLAW_PROFILE: profile, OPENCLAW_CONTAINER_HINT: undefined }, () => {
      expect(() => assertSqliteFlipStartupRefusal(startupRefusal(command))).not.toThrow();
    });
  });

  it.each(["openclaw doctor --fix", "openclaw --profile unrelated doctor --fix"])(
    "rejects guidance outside the active profile: %s",
    (command) => {
      withEnv({ OPENCLAW_PROFILE: "qa-sqlite-proof", OPENCLAW_CONTAINER_HINT: undefined }, () => {
        const refusal = startupRefusal(command);
        expect(() => assertSqliteFlipStartupRefusal(refusal)).toThrow(
          expect.objectContaining({
            actual: refusal.message,
            expected: 'Run "openclaw --profile qa-sqlite-proof doctor --fix"',
          }),
        );
      });
    },
  );

  it("rejects valid guidance when a legacy source was not preserved", () => {
    withEnv({ OPENCLAW_PROFILE: undefined, OPENCLAW_CONTAINER_HINT: undefined }, () => {
      const refusal = startupRefusal("openclaw doctor --fix");
      refusal.preservedSourceFiles.pop();
      expect(() => assertSqliteFlipStartupRefusal(refusal)).toThrow(
        expect.objectContaining({ actual: refusal.preservedSourceFiles }),
      );
    });
  });
});
