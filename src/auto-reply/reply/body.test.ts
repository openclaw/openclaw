import { describe, expect, it } from "vitest";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import { applySessionHints } from "./body.js";

describe("applySessionHints", () => {
  it("consumes the process-local abort hint without a session write", () => {
    const abortKey = "session-hint-without-store";
    setAbortMemory(abortKey, true);
    expect(applySessionHints({ baseBody: "continue", abortedLastRun: true, abortKey })).toContain(
      "previous agent run was interrupted",
    );
    expect(getAbortMemory(abortKey)).toBeUndefined();
  });

  it.each([true, false])(
    "tells the model a user's Stop ended the last run (abortedLastRun: %s)",
    (abortedLastRun) => {
      const body = applySessionHints({ baseBody: "next", abortedLastRun, stoppedByUser: true });
      expect(body).toContain("The user stopped the previous agent run");
      expect(body).not.toContain("continue the unfinished work");
    },
  );
});
