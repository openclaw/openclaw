import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

it("keeps Gateway session selection independent of execution lifecycle", () => {
  expect(
    findSourceImportBackedges("src/commands/agent/session.runtime.ts", [
      "src/agents/command/session.ts",
      "src/config/sessions/session-accessor.ts",
      "src/config/sessions/session-accessor.entry.ts",
      "src/config/sessions/session-accessor.reset.ts",
      "src/config/sessions/session-accessor.lifecycle.ts",
      "src/config/sessions/session-accessor.sqlite-transcript-write.ts",
      "src/agents/bootstrap-cache.ts",
      "src/agents/main-session-recovery/main-session-recovery-state.ts",
    ]),
  ).toEqual([]);
});
