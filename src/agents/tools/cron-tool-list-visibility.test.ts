import { expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";

it("explains that agent cron list metadata is caller-scoped", () => {
  const tool = createCronTool();

  expect(tool.description).toContain(
    "In an agent session, list results are restricted to automations visible to the calling agent",
  );
  expect(tool.description).toContain(
    "total, pagination, and snapshotRevision describe this restricted view, not the complete Gateway inventory",
  );
});
