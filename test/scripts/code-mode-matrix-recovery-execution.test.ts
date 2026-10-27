import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createRecoveryMatrixFixture } from "../../scripts/lib/code-mode-matrix-recovery-tasks.js";
import { applyCodeModeCatalog } from "../../src/agents/code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "../../src/agents/code-mode.test-support.js";
import { createReadTool } from "../../src/agents/sessions/tools/read.js";
import { createWriteTool } from "../../src/agents/sessions/tools/write.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { setPluginToolMeta } from "../../src/plugins/tool-metadata.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { settlementRecoveryProgram } from "./code-mode-matrix-recovery.test-support.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  await resetCodeModeTestState();
  tempDirs.cleanup();
});

it("reconciles uncertain settlements through public exec/wait without replaying effects", async () => {
  const fixture = createRecoveryMatrixFixture("batch-settlement-recovery", 0);
  const workspace = tempDirs.make("code-mode-recovery-");
  const receiptsPath = path.join(workspace, "receipts.jsonl");
  const pluginPath = path.join(workspace, "fixture.mjs");
  fs.writeFileSync(pluginPath, expectDefined(fixture.pluginSource, "native recovery fixture"));
  const {
    default: register,
  }: {
    default: (api: {
      pluginConfig: { receiptsPath: string };
      registerTool: (tool: AnyAgentTool) => void;
    }) => void;
  } = await import(pathToFileURL(pluginPath).href);
  const targets: AnyAgentTool[] = [];
  register({
    pluginConfig: { receiptsPath },
    registerTool(tool) {
      setPluginToolMeta(tool, { pluginId: "code-mode-matrix-fixture", optional: false });
      targets.push(tool);
    },
  });
  targets.push(createReadTool(workspace), createWriteTool(workspace));
  const observations = targets.map((tool) => vi.spyOn(tool, "execute"));
  const harness = createCodeModeHarness({ codeMode: { executor: "node" } });
  applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, ...targets] });
  const execTool = expectDefined(harness.tools[0], "public Code Mode exec");
  const waitTool = expectDefined(harness.tools[1], "public Code Mode wait");
  const exec = vi.spyOn(execTool, "execute");
  const wait = vi.spyOn(waitTool, "execute");
  const details = await runUntilCompleted({
    execTool,
    waitTool,
    code: `
      const recover = ${settlementRecoveryProgram};
      const { report, failures } = await recover({
        call: (name, input = {}) => ({ matrix_settlement_batch, matrix_settle_operation,
          matrix_inspect_settlements })[name](input),
        onFailure: () => yield_control(),
      });
      await write({ path: "settlement-report.json", content: JSON.stringify(report) });
      const readback = await read({ path: "settlement-report.json" });
      return { report: JSON.parse(readback.content), readbackKind: readback.kind,
        failures: failures.map(({ message, effectCount }) => ({ message, effectCount })) };
    `,
  });

  expect(details.status, JSON.stringify(details)).toBe("completed");
  const persisted: unknown = JSON.parse(
    fs.readFileSync(path.join(workspace, "settlement-report.json"), "utf8"),
  );
  expect(details.value).toEqual({
    report: persisted,
    readbackKind: "text",
    failures: [0, 0, 1, 1].map((effectCount) => ({
      effectCount,
      message:
        "Settlement response unavailable; the effect outcome is unknown. Inspect actual state before another attempt.",
    })),
  });
  const receipts: unknown[] = fs
    .readFileSync(receiptsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const checks = await fixture.evaluate({
    workspace,
    receipts,
    trace: { calls: [], outcomes: [], activities: [], assistantTurns: 0, models: [] },
  });
  expect(checks).toEqual({
    completeSourceRead: true,
    requiredFailuresObserved: true,
    inspectedBeforeRetry: true,
    exactlyOnceEligibleEffects: true,
    blockedEffectsAbsent: true,
    preexistingPreserved: true,
    finalStateInspected: true,
    exactReport: true,
  });
  // Wait resumes the same guest after each uncertain result, never a new exec.
  expect(exec).toHaveBeenCalledOnce();
  expect(wait.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(details.telemetry).toMatchObject({ callCount: 20 });
  const nestedIds = observations.flatMap((execute) =>
    execute.mock.calls.map(([toolCallId]) => toolCallId),
  );
  expect([nestedIds.length, new Set(nestedIds).size]).toEqual([20, 20]);
  expect(nestedIds.every((id) => id.startsWith("tool_call:code-call-1:"))).toBe(true);
});
