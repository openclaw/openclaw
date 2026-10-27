import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as flushDiagnosticEvents } from "node:timers/promises";
import { Type } from "typebox";
import { expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticSkillUsedEvent,
} from "../../infra/diagnostic-events.js";
import { registerDiagnosticTracePropagationBridge } from "../../infra/diagnostic-trace-propagation.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { wrapReadToolWithSkillContent } from "../agent-tools.read.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it("records successful discovered skill reads with the original sandbox provenance", async () => {
  const skillFile = "/host/skills/guide/SKILL.md";
  const readPath = "/sandbox/skills/guide/SKILL.md";
  const skill = createCanonicalFixtureSkill({
    name: "guide",
    description: "Guide",
    filePath: readPath,
    baseDir: "/sandbox/skills/guide",
    source: "workspace",
  });
  const tools = createInstalledSkillTools([
    {
      name: skill.name,
      description: skill.description,
      location: readPath,
      source: { filePath: readPath, readContent: "Whole instructions" },
    },
  ]);
  const runId = "installed-skill-usage";
  const tool = wrapToolWithBeforeToolCallHook(tools[1]!, {
    runId,
    agentId: "main",
    workspaceDir: "/sandbox",
    skillsSnapshot: {
      prompt: "",
      skills: [{ name: "guide" }],
      resolvedSkills: [],
      discoverySkills: [skill],
    },
    skillUsagePaths: [{ skillName: "guide", skillSource: "workspace", skillFile, readPath }],
    loopDetection: { enabled: false },
  });
  await expect(tool.execute("invalid", { name: "unknown" })).rejects.toThrow();
  expect(consumeRunSkillUsage(runId)).toEqual([]);
  await tool.execute("read-guide", { name: "guide" });
  expect(consumeRunSkillUsage(runId)).toEqual([
    { name: "guide", source: "workspace", activation: "read", skillFile },
  ]);
});

it.each(["read", "skills_read"])(
  "fingerprints only delivered instructions through %s",
  async (toolName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-delivery-"));
    const filePath = path.join(root, "SKILL.md");
    const supportPath = path.join(root, "support.md");
    const first = "# Pond\nRead the pond gauge.\n";
    const second = "# Pond\nRead the pond gauge twice.\n";
    const firstHash = "4df1c26d46f273f2b411308b178053937c8821a807f8e8497b30ba09335ccd49";
    const secondHash = "c15c4770556dcf52994a4ee9258fb7b3ad2a9fa9fb9ea1257ed7be3f90d5c28f";
    const cache = new Map<string, Promise<boolean>>();
    const skill = createCanonicalFixtureSkill({
      name: "pond",
      description: "Pond",
      filePath,
      baseDir: root,
      source: "workspace",
    });
    const readContent = () => fs.readFile(filePath, "utf8");
    const raw =
      toolName === "read"
        ? wrapReadToolWithSkillContent(
            {
              name: "read",
              label: "Read",
              description: "Read a file",
              parameters: Type.Object({ path: Type.String() }),
              execute: async () => {
                const content = await readContent();
                return {
                  content: [{ type: "text", text: content }],
                  details: { kind: "text", content },
                };
              },
            },
            [{ filePath }],
            { instructionDeliveryCache: cache },
          )
        : createInstalledSkillTools([
            {
              name: skill.name,
              description: skill.description,
              location: filePath,
              source: { filePath },
              reader: readContent,
              promptListed: true,
            },
          ])[1]!;
    const tool = wrapToolWithBeforeToolCallHook(raw, {
      workspaceDir: root,
      skillsSnapshot: { prompt: "", skills: [{ name: skill.name }], resolvedSkills: [skill] },
      loopDetection: { enabled: false },
    });
    const events: DiagnosticSkillUsedEvent[] = [];
    const stopEvents = onInternalDiagnosticEvent((event) => {
      if (event.type === "skill.used") {
        events.push(event);
      }
    });
    const stopTracing = registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => undefined,
      prepareEvent: () => {},
    });
    try {
      await fs.writeFile(filePath, first);
      await fs.writeFile(supportPath, "Unread support version one");
      const args = toolName === "read" ? { path: filePath } : { name: "pond" };
      await tool.execute("first-delivery", args);
      await fs.writeFile(supportPath, "Unread support version two");
      await tool.execute("support-only-edit", args);
      await fs.writeFile(filePath, second);
      await tool.execute("changed-source", args);
      cache.clear();
      await tool.execute("fresh-delivery", args);
      await flushDiagnosticEvents();
      expect(events.map((event) => event.skillFingerprint)).toEqual([
        firstHash,
        firstHash,
        toolName === "read" ? firstHash : secondHash,
        secondHash,
      ]);
      expect(JSON.stringify(events)).not.toContain(first);
      expect(JSON.stringify(events)).not.toContain(filePath);
      stopTracing();
      await tool.execute("tracing-disabled", args);
      await flushDiagnosticEvents();
      expect(events).toHaveLength(5);
      expect(events[4]).not.toHaveProperty("skillFingerprint");
    } finally {
      stopTracing();
      stopEvents();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
