import { expect, it } from "vitest";
import { projectTranscriptNavigationFields } from "./transcript-navigation-fields.js";

it("preserves raw navigation fields without retaining payloads in either target form", () => {
  const event = {
    id: "entry",
    parentId: undefined,
    appendMode: false,
    message: { content: "body" },
  };
  const navigation = { id: "entry", parentId: undefined, appendMode: false };
  const projected = projectTranscriptNavigationFields(event);
  expect(projected).toEqual(navigation);
  expect(projectTranscriptNavigationFields(event)).not.toBe(projected);

  const usageEntry = { tokens: 7 };
  const target = { seq: 9, usageEntry };
  expect(projectTranscriptNavigationFields(event, target)).toBe(target);
  expect(target).toEqual({ seq: 9, usageEntry: { tokens: 7 }, ...navigation });
  expect(target.usageEntry).toBe(usageEntry);
});
