import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isAgentToolExecutionAvailable } from "../../agents/agent-tool-availability.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  installRequesterCronAuthorityTestHooks,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { admitEventOccurrence } from "../event-occurrence-admission.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../scheduled-occurrence.test-support.js";
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

// Records every automations Gateway RPC the tool dispatches, then runs it unchanged.
const gatewayDispatches = vi.hoisted((): string[] => []);
vi.mock("../../agents/tools/cron-tool-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/tools/cron-tool-gateway.js")>();
  return {
    ...actual,
    createCronToolGatewayCaller: ((
      ...args: Parameters<typeof actual.createCronToolGatewayCaller>
    ) => {
      const call = actual.createCronToolGatewayCaller(...args);
      return ((method: string, ...rest: unknown[]) => {
        gatewayDispatches.push(method);
        return (call as (method: string, ...rest: unknown[]) => unknown)(method, ...rest);
      }) as typeof call;
    }) as typeof actual.createCronToolGatewayCaller,
  };
});

// Hook turns (src/gateway/server/hooks.ts) and channel join introductions run
// through the cron runner with trigger "event". Their automations scope comes
// from the admitted execution context: their own automation, or none.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
installRequesterCronAuthorityTestHooks();

beforeEach(() => {
  resetAuthorityRunHarness();
  delete ownerSurface.last;
  gatewayDispatches.length = 0;
});

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

// The owner-only surface the last run's tools got: its sender bit and which
// owner-only tools it may call.
const ownerSurface: {
  last?: { senderIsOwner: boolean | undefined; callable: Record<string, boolean> };
} = {};

type AutomationsOutcome =
  | { offered: false }
  | { offered: true; actions: string[]; error?: string; gated?: true };

function readActionEnum(tool: { parameters?: unknown }): string[] {
  const action = (tool.parameters as { properties?: { action?: { enum?: unknown } } } | undefined)
    ?.properties?.action;
  return Array.isArray(action?.enum) ? (action.enum as string[]) : [];
}

async function runAndTouchSibling(params: {
  trigger: "cron" | "event";
  toolsAllow?: string[];
  /** Event turns admit through `admitEventOccurrence` unless set to "unadmitted". */
  ingressBoundary?: "gateway.hooks.agent" | "unadmitted";
  /** The automations call to make; defaults to removing a sibling job. */
  call?: Record<string, unknown>;
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
        const ownerOnly: readonly string[] = GATEWAY_OWNER_ONLY_CORE_TOOLS;
        ownerSurface.last = {
          senderIsOwner: runParams.senderIsOwner,
          callable: Object.fromEntries(
            constructed
              .filter((tool) => ownerOnly.includes(tool.name))
              .map((tool) => [tool.name, isAgentToolExecutionAvailable(tool)]),
          ),
        };
        const tools = applyEmbeddedAttemptToolsAllow(constructed, runParams.toolsAllow, {
          toolMeta: getPluginToolMeta,
        });
        const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
        if (!automations) {
          outcome = { offered: false };
        } else {
          const actions = readActionEnum(automations);
          try {
            const result = await automations.execute(
              "touch-sibling",
              params.call ?? { action: "remove", jobId: "sibling-job" },
            );
            // A tool the turn may not call returns a gated refusal instead of throwing.
            const gated = (result as { details?: { gated?: unknown } }).details?.gated === true;
            outcome = { offered: true, actions, ...(gated ? { gated: true as const } : {}) };
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
  const job = hookShapedJob(params.toolsAllow);
  const occurrence =
    params.trigger === "event" && params.ingressBoundary !== "unadmitted"
      ? await admitEventOccurrence({
          cfg: config,
          job,
          agentId: "main",
          ...(params.ingressBoundary ? { ingressBoundary: params.ingressBoundary } : {}),
        })
      : TEST_SCHEDULED_OCCURRENCE;
  await runCronIsolatedAgentTurn({
    cfg: config,
    deps: {},
    occurrence,
    job,
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

// The self-scoped schema never offers job creation. Its exact action list is
// owned by cron-tool-schema.ts and grows with active-run features.
const SELF_ACTIONS = expect.not.arrayContaining(["add"]);

it("cron-triggered turns cannot act on another automation", async () => {
  const outcome = await runAndTouchSibling({ trigger: "cron" });
  expect(outcome).toEqual({
    offered: true,
    actions: SELF_ACTIONS,
    error: expect.stringContaining(SCOPE_ERROR),
  });
  expect(gatewayDispatches).toEqual([]);
});

it("event-triggered hook turns cannot act on another automation", async () => {
  const outcome = await runAndTouchSibling({
    trigger: "event",
    ingressBoundary: "gateway.hooks.agent",
  });
  expect(outcome).toEqual({
    offered: true,
    actions: SELF_ACTIONS,
    error: expect.stringContaining(SCOPE_ERROR),
  });
  expect(gatewayDispatches).toEqual([]);
});

it("event-triggered turns without an admitted context cannot use automations", async () => {
  const outcome = await runAndTouchSibling({ trigger: "event", ingressBoundary: "unadmitted" });
  expect(outcome).toEqual({ offered: true, actions: expect.any(Array), gated: true });
  // Refused before any automations Gateway RPC, so nothing can be read or removed.
  expect(gatewayDispatches).toEqual([]);
});

it("channel join introductions are offered no automations tool", async () => {
  const outcome = await runAndTouchSibling({ trigger: "event", toolsAllow: [] });
  expect(outcome).toEqual({ offered: false });
});

// Owner status for ingress turns is a separate decision: hook turns keep the
// embedded owner surface (no sender bit, every owner-only tool except intent).
it("hook turns keep their existing owner-only surface", async () => {
  await runAndTouchSibling({ trigger: "event", ingressBoundary: "gateway.hooks.agent" });
  const surface = ownerSurface.last;
  expect(surface).toBeDefined();
  expect(surface?.senderIsOwner).toBeUndefined();
  const callable = surface?.callable ?? {};
  expect(callable[AUTOMATIONS_TOOL_NAME]).toBe(true);
  expect(Object.keys(callable).length).toBeGreaterThan(1);
  for (const [name, available] of Object.entries(callable)) {
    expect({ name, available }).toEqual({ name, available: name !== "intent" });
  }
});

// Control for the dispatch assertions above: an allowed call from an admitted
// hook turn does reach the automations Gateway RPC.
it("an admitted hook turn's own list call reaches the Gateway", async () => {
  await runAndTouchSibling({
    trigger: "event",
    ingressBoundary: "gateway.hooks.agent",
    call: { action: "list" },
  });
  expect(gatewayDispatches).toContain("cron.list");
});
