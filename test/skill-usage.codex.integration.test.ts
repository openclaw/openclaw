import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "../extensions/codex/test-api.js";
import { asToolParamsRecord, type AnyAgentTool } from "../src/agents/tools/common.js";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
  waitForDiagnosticEventsDrained,
} from "../src/infra/diagnostic-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../src/plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { consumeRunSkillUsage } from "../src/skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../src/skills/test-support/test-helpers.js";
import { registerSkillUsageTracking } from "../src/skills/workshop/skill-usage.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

let testState: OpenClawTestState;
type ReadOutcome = "error" | "blocked" | "thrown" | "policy" | "unknown";

describe("persistent skill usage through registered Codex dynamic tools", () => {
  const runId = "skill-usage-run";
  const skillName = "daily-brief";
  let skillFile: string;
  let unregisterUsage: ReturnType<typeof registerSkillUsageTracking>;
  let publicEvents: DiagnosticEventPayload[];
  let sharedEvents: DiagnosticEventPayload[];
  let trustedEvents: DiagnosticEventPayload[];

  beforeEach(async () => {
    testState = await createOpenClawTestState({ prefix: "skill-usage-", applyEnv: true });
    resetDiagnosticEventsForTest();
    skillFile = await testState.writeText("skills/daily-brief/SKILL.md", "# Daily brief\n");
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
    setDiagnosticsEnabledForProcess(false);
    publicEvents = [];
    sharedEvents = [];
    trustedEvents = [];
    onDiagnosticEvent((event) => publicEvents.push(event));
    onInternalDiagnosticEvent((event) => sharedEvents.push(event), { include: ["skill.used"] });
    onTrustedInternalDiagnosticEvent((event) => trustedEvents.push(event), {
      include: ["skill.used"],
    });
    unregisterUsage = registerSkillUsageTracking({ env: testState.env });
  });

  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    await unregisterUsage();
    consumeRunSkillUsage(runId);
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await testState.cleanup();
    closeOpenClawStateDatabaseForTest();
  });

  function createBridge(kind: ReadOutcome | "read" | "command" = "read") {
    if (kind === "policy") {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: async () => ({ block: true, blockReason: "Blocked by test policy" }),
          },
        ]),
      );
    }
    const execute = vi.fn<AnyAgentTool["execute"]>(async (_callId, args) => {
      if (kind === "error" || kind === "blocked") {
        return {
          content: [{ type: "text", text: "Read did not complete" }],
          details: { status: kind },
        };
      }
      if (kind === "thrown") {
        throw new Error("Read failed");
      }
      const filePath = asToolParamsRecord(args).path;
      if (typeof filePath !== "string") {
        throw new Error("Expected a file path");
      }
      return {
        content: [{ type: "text", text: await fs.readFile(filePath, "utf8") }],
        details: {},
      };
    });
    const toolName = kind === "command" ? "daily_brief" : "read";
    const bridge = createCodexDynamicToolBridge({
      tools: [
        {
          name: toolName,
          label: toolName,
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
          execute,
        },
      ],
      signal: new AbortController().signal,
      hookContext: {
        agentId: "main",
        sessionKey: "agent:main:skill-usage",
        sessionId: "skill-usage-session",
        runId,
        workspaceDir: testState.workspaceDir,
        loopDetection: { enabled: false },
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: skillName }],
          resolvedSkills: [
            createCanonicalFixtureSkill({
              name: skillName,
              description: "Daily brief",
              filePath: skillFile,
              baseDir: path.dirname(skillFile),
              source: "workspace",
            }),
          ],
        },
        ...(kind === "command"
          ? {
              skillCommand: {
                commandName: "daily-brief",
                skillName,
                skillSource: "workspace",
                skillFile,
                toolName,
              },
            }
          : {}),
      },
    });
    const call = (callId: string, filePath = skillFile) =>
      bridge.handleToolCall({
        threadId: "skill-usage-thread",
        turnId: "skill-usage-turn",
        callId,
        namespace: "openclaw",
        tool: toolName,
        arguments: { path: filePath },
      });
    return { call, execute };
  }

  async function expectUsage(count: number) {
    await waitForDiagnosticEventsDrained();
    await unregisterUsage();
    const row = {
      skill_file: skillFile,
      skill_name: skillName,
      skill_source: "workspace",
      use_count: count,
      last_agent_id: "main",
    };
    const rows = openOpenClawStateDatabase({ env: testState.env })
      .db.prepare(
        "SELECT skill_file, skill_name, skill_source, use_count, last_agent_id FROM skill_usage",
      )
      .all();
    expect(rows).toEqual(count === 0 ? [] : [row]);
  }

  it.each([false, true])(
    "counts repeated successful reads with process diagnostics=%s",
    async (enabled) => {
      setDiagnosticsEnabledForProcess(enabled);
      const { call, execute } = createBridge();
      expect(await call("read-1")).toMatchObject({
        success: true,
        contentItems: [{ type: "inputText", text: "# Daily brief\n" }],
      });
      await expectUsage(1);
      unregisterUsage = registerSkillUsageTracking({ env: testState.env });
      expect(await call("read-2")).toMatchObject({ success: true });
      await expectUsage(2);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(consumeRunSkillUsage(runId)).toEqual([
        { name: skillName, source: "workspace", activation: "read", skillFile },
      ]);
      expect(consumeRunSkillUsage(runId)).toEqual([]);
      expect(publicEvents).toEqual([]);
      expect(sharedEvents.map((event) => event.type)).toEqual(
        enabled ? ["skill.used", "skill.used"] : [],
      );
      expect(trustedEvents.map((event) => event.type)).toEqual(["skill.used", "skill.used"]);
      expect(JSON.stringify([...sharedEvents, ...trustedEvents])).not.toContain(skillFile);
    },
  );

  it.each(["error", "blocked", "thrown", "policy", "unknown"] as const)(
    "does not count a %s read",
    async (kind) => {
      const { call, execute } = createBridge(kind);
      const file =
        kind === "unknown"
          ? await testState.writeText("skills/unknown/SKILL.md", "Other file\n")
          : skillFile;
      expect(await call(`${kind}-read`, file)).toMatchObject({
        success: kind === "unknown",
        ...(kind === "policy" ? { executionStarted: false } : {}),
      });
      expect(execute).toHaveBeenCalledTimes(kind === "policy" ? 0 : 1);
      await expectUsage(0);
      expect(consumeRunSkillUsage(runId)).toEqual([]);
      expect(trustedEvents).toEqual([]);
    },
  );

  it("preserves explicit tool-dispatched skill command activation", async () => {
    const { call } = createBridge("command");
    expect(await call("skill-command")).toMatchObject({ success: true });
    await expectUsage(1);
    expect(consumeRunSkillUsage(runId)).toEqual([
      { name: skillName, source: "workspace", activation: "command", skillFile },
    ]);
    expect(trustedEvents).toMatchObject([
      { type: "skill.used", activation: "command", toolName: "daily_brief" },
    ]);
  });
});
