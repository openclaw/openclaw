import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

it("loads the upstream monitor without the embedded agent execution runtime", () => {
  expect(
    findSourceImportBackedges("src/sessions/session-upstream-monitor.ts", [
      "src/agents/embedded-agent.ts",
      "src/agents/embedded-agent-runner.ts",
    ]),
  ).toEqual([]);
});
