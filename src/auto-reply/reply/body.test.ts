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
});
