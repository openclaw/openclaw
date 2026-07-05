// Tests gateway active-run matching by logical session key and backing id.
import { expect, it } from "vitest";
import { hasVisibleActiveSessionRun } from "./session-active-runs.js";

it("matches session-id-only gateway runs during archive admission", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

  expect(
    hasVisibleActiveSessionRun({
      context,
      requestedKey: "agent:main:child",
      canonicalKey: "agent:main:child",
      sessionId: "session-1",
    }),
  ).toBe(true);
});
