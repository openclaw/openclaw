import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  installRequesterCronAuthorityTestHooks,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import type { CronJob } from "../types.js";
import {
  prepareAuthorityConfig,
  resetAuthorityRunHarness,
  withAuthorityTools,
} from "./run.authority.test-support.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

// Hook turns (src/gateway/server/hooks.ts) and channel join introductions run
// through the cron runner with trigger "event". They must get the same
// current-job automations scope as scheduled runs.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
installRequesterCronAuthorityTestHooks();

beforeEach(resetAuthorityRunHarness);

afterEach(() => {
  runEmbeddedAgentMock.mockReset();
});

const SCOPE_ERROR = "Automations tool is restricted to the current automation.";

// Mirrors the job built for an HTTP hook turn (hooks.ts:300-321).
function hookShapedJob(toolsAllow?: string[]): CronJob {
  const nowMs = Date.now();
  return {
    id: "hook-turn-job",
    agentId: "main",
    name: "Hook turn",
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "at", at: new Date(nowMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Summarize the webhook payload",
      externalContentSource: "webhook",
      ...(toolsAllow ? { toolsAllow } : {}),
    },
    delivery: { mode: "none" },
    state: { nextRunAtMs: nowMs },
  };
}

type AutomationsOutcome = { offered: false } | { offered: true; actions: string[]; error?: string };

function readActionEnum(tool: { parameters?: unknown }): string[] {
  const action = (tool.parameters as { properties?: { action?: { enum?: unknown } } } | undefined)
    ?.properties?.action;
  return Array.isArray(action?.enum) ? (action.enum as string[]) : [];
}

async function runAndTouchSibling(params: {
  trigger: "cron" | "event";
  toolsAllow?: string[];
}): Promise<AutomationsOutcome> {
  // Admission and the prepared session must name the same physical store.
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const config = await prepareAuthorityConfig({ session: { store: storePath } });
  resolveCronSessionMock.mockReturnValue(makeCronSession({ storePath }));
  let outcome: AutomationsOutcome | undefined;
  runEmbeddedAgentMock.mockImplementation(async (runParams: RunEmbeddedAgentParams) =>
    withAuthorityTools(
      runParams,
      async (constructed) => {
        const tools = applyEmbeddedAttemptToolsAllow(constructed, runParams.toolsAllow, {
          toolMeta: getPluginToolMeta,
        });
        const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
        if (!automations) {
          outcome = { offered: false };
        } else {
          const actions = readActionEnum(automations);
          try {
            await automations.execute("touch-sibling", {
              action: "remove",
              jobId: "sibling-job",
            });
            outcome = { offered: true, actions };
          } catch (error) {
            outcome = { offered: true, actions, error: String(error) };
          }
        }
        return { payloads: [{ text: "done" }], meta: { agentMeta: {} } };
      },
      // The embedded attempt forwards trigger and jobId into tool construction
      // (embedded-agent-runner/run/attempt-tool-run-context.ts).
      { includeOpenClawTools: true, trigger: runParams.trigger, jobId: runParams.jobId },
    ),
  );
  await runCronIsolatedAgentTurn({
    cfg: config,
    deps: {},
    job: hookShapedJob(params.toolsAllow),
    trigger: params.trigger,
    deliveryAttemptFence: null,
    message: "Summarize the webhook payload",
    sessionKey: "hook:event-trigger-scope",
    agentId: "main",
  });
  if (!outcome) {
    throw new Error("embedded run did not construct tools");
  }
  return outcome;
}

const SELF_ACTIONS = ["status", "list", "get", "remove", "runs", "next_check"];

it("cron-triggered turns cannot act on another automation", async () => {
  const outcome = await runAndTouchSibling({ trigger: "cron" });
  expect(outcome).toEqual({
    offered: true,
    actions: SELF_ACTIONS,
    error: expect.stringContaining(SCOPE_ERROR),
  });
});

it("event-triggered hook turns cannot act on another automation", async () => {
  const outcome = await runAndTouchSibling({ trigger: "event" });
  expect(outcome).toEqual({
    offered: true,
    actions: SELF_ACTIONS,
    error: expect.stringContaining(SCOPE_ERROR),
  });
});

it("channel join introductions are offered no automations tool", async () => {
  const outcome = await runAndTouchSibling({ trigger: "event", toolsAllow: [] });
  expect(outcome).toEqual({ offered: false });
});
