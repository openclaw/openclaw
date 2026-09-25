import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it("searches and reads through the model-facing tool contract without reading other paths", async () => {
  const tools = createInstalledSkillTools([
    {
      name: "release-guide",
      description: "Publish a software release",
      location: "/skills/release/SKILL.md",
      source: {
        filePath: "/skills/release/SKILL.md",
        readContent: "# Release\n\nCheck everything.\n",
      },
    },
  ]);
  const search = expectDefined(tools[0], "installed skill search tool");
  const read = expectDefined(tools[1], "installed skill read tool");
  expect((await search.execute("find", { query: "publish release" })).details).toEqual({
    skills: [
      {
        name: "release-guide",
        description: "Publish a software release",
        location: "/skills/release/SKILL.md",
      },
    ],
    hasMore: false,
  });
  expect((await read.execute("load", { name: "release-guide" })).content).toEqual([
    { type: "text", text: "# Release\n\nCheck everything.\n" },
  ]);
  await expect(read.execute("invalid", { name: "/etc/passwd" })).rejects.toThrow(
    "Unknown installed skill",
  );
  expect(createInstalledSkillTools([])).toEqual([]);
});
