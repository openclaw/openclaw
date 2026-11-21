import { expect, it } from "vitest";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "../src/agents/tool-search.js";
import { createInstalledSkillTools } from "../src/agents/tools/installed-skill-tools.js";
import { formatSkillsForPromptCore } from "../src/skills/loading/skill-contract.js";
import { makeSkill } from "../src/skills/test-support/test-helpers.js";
import { startSkillLibraryWireProvider } from "./e2e/qa-lab/runtime/skill-library-wire-provider.js";

it("uses the newest canonical user-message catalog and dispatches the authorized skill read", async () => {
  const provider = await startSkillLibraryWireProvider();
  try {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: createInstalledSkillTools([
        {
          name: "guide",
          description: "Guide",
          location: "/worker/skills/guide/SKILL.md",
          source: {
            filePath: "/worker/skills/guide/SKILL.md",
            readContent: "Run scripts/report.mjs.",
          },
        },
      ]),
    });
    const dispatcher = createToolSearchTools({ catalogRef }).find(
      (tool) => tool.name === "dispatch_action",
    )!;
    const input: unknown[] = [
      { role: "user", content: "SKILL-LIBRARY-PROBE:updated name=guide" },
      {
        role: "user",
        content: `System prompt update
${formatSkillsForPromptCore([makeSkill("guide", "Current guide")])}`,
      },
    ];
    const body = {
      instructions: formatSkillsForPromptCore([
        makeSkill("guide", "Old guide"),
        makeSkill("stale", "Removed guide"),
      ]),
      input,
      tools: [{ name: dispatcher.name, parameters: dispatcher.parameters }, { name: "exec" }],
    };
    const request = async () => {
      const response = await fetch(provider.baseUrl + "/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(provider.errors).toEqual([]);
      const events = wire
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      return events.find((event) => event.type === "response.output_item.done")?.item;
    };
    const read = await request();
    expect(read).toMatchObject({ type: "function_call", name: "dispatch_action" });
    expect(JSON.parse(read.arguments)).toEqual({ id: "skills_read", args: { name: "guide" } });
    expect(provider.observations.get("updated")?.catalogs).toEqual([[{ name: "guide" }]]);
    const result = await dispatcher.execute(read.call_id, JSON.parse(read.arguments));
    const output = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    input.push(read, { type: "function_call_output", call_id: read.call_id, output });
    const exec = await request();
    expect(exec).toMatchObject({ type: "function_call", name: "exec" });
    expect(JSON.parse(exec.arguments)).toEqual({
      command: "node '/worker/skills/guide/scripts/report.mjs'",
    });
    expect(provider.observations.get("updated")?.readOutput).toContain(
      "Skill location: /worker/skills/guide/SKILL.md",
    );
  } finally {
    await provider.stop();
  }
});
