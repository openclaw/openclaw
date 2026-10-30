import { expect, it } from "vitest";
import { buildConfigSchemaCore } from "./schema.js";

it("C1: exposes Workshop settings with labels and help in the common settings tier", () => {
  const { uiHints } = buildConfigSchemaCore();
  const described = { label: expect.any(String), help: expect.any(String), advanced: false };
  expect(uiHints["skills.workshop.autonomous.mode"]).toMatchObject(described);
  expect(uiHints["skills.workshop.autonomous.channelNotices"]).toMatchObject(described);
  // Settings users read the help to discover each mode.
  for (const mode of ['"auto"', '"propose"', '"off"']) {
    expect(uiHints["skills.workshop.autonomous.mode"]?.help).toContain(mode);
  }
});
