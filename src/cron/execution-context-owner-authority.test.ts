import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { useWidgetHarness } from "../canvas/widget-tool.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import type {
  ScheduledExecutionContextResult,
  ScheduledExecutionFacts,
} from "./execution-context.js";
import type { CronStoredJob } from "./types.js";

// The resident profile catalog is the profile requester's existing owner; the test
// controls whether the requester's profile is current.
const profile = vi.hoisted(() => ({ current: true }));
vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: (profileId: string) => {
    const assertCurrent = () => {
      if (!profile.current) {
        throw new Error(`profile ${profileId} was removed`);
      }
    };
    assertCurrent();
    return { assertCurrent };
  },
}));
// A stand-in for the plugin-provided standing-intents tool, which needs an
// explicit owner identity that no scheduled run carries.
const intentTools = vi.hoisted(() => () => [
  {
    name: "intent",
    label: "Intent",
    description: "Standing intents.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "intent ok" }], details: {} }),
  },
]);
vi.mock("../agents/openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => intentTools(),
  resolveOpenClawPluginToolsForOptionsAsync: async () => intentTools(),
}));

// Owner-only tools that pass their gate stop at the in-process Gateway, which refuses.
vi.mock("../agents/tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/in-process-gateway.js")>()),
  callInProcessGatewayTool: async () => {
    throw new Error("test gateway refuses calls");
  },
}));

const { createOpenClawCodingToolsInternalAsync } = await import("../agents/agent-tools.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");
const { createAdmittedHostCapabilityTestFixture } =
  await import("../agents/harness/host-capability.test-support.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { resolveScheduledSenderBit } = await import("./execution-context-registry.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const PROFILE = { type: "human", source: "profile", id: "profile-requester" } as const;
const OWNER_ONLY: ReadonlySet<string> = new Set(GATEWAY_OWNER_ONLY_CORE_TOOLS);
const TOOLS_ALLOW = ["*"];
const CFG: OpenClawConfig = {};

function job(overrides: Partial<CronStoredJob>): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Owner authority",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "work" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

const linked = { sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } };
const accountPolicy = {
  scheduledToolPolicy: {
    mode: "account",
    ownerSessionKey: PARENT_KEY,
    ownerAccountId: "default",
  },
} as Partial<CronStoredJob>;

/**
 * One stored job per principal kind, with the sender bit both runtimes must share.
 * An owner run is an internal turn and carries no sender bit.
 */
const PRINCIPALS = [
  {
    name: "operator job (trusted policy)",
    job: job({ scheduledToolPolicy: { mode: "trusted" } } as Partial<CronStoredJob>),
    senderIsOwner: undefined,
  },
  {
    name: "unbound parent (key only)",
    job: job({ ...accountPolicy, owner: { agentId: "main", sessionKey: PARENT_KEY } }),
    senderIsOwner: undefined,
  },
  {
    name: "parent with an owner profile requester",
    job: job({ ...linked, createdActor: PROFILE }),
    senderIsOwner: undefined,
  },
  {
    name: "parent with a non-owner profile requester",
    job: job({ ...linked, createdActor: PROFILE }),
    senderIsOwner: false,
    profileCurrent: false,
  },
  {
    name: "parent with no recorded requester",
    job: job({ ...linked, ...accountPolicy }),
    senderIsOwner: false,
  },
  {
    name: "v2026.10.6 operator-linked parent (trusted policy, no requester)",
    job: job({ ...linked, scheduledToolPolicy: { mode: "trusted" } } as Partial<CronStoredJob>),
    senderIsOwner: undefined,
  },
] as const;

useWidgetHarness();

beforeEach(() => {
  setRuntimeConfigSnapshot(CFG);
});
afterEach(() => {
  profile.current = true;
});

function seedParent() {
  replaceSessionEntrySync(
    { sessionKey: PARENT_KEY },
    { sessionId: "parent-session", lifecycleRevision: "rev-1", updatedAt: Date.now() },
  );
  replaceSessionEntrySync(
    { sessionKey: RUN_KEY },
    { sessionId: "run-session", updatedAt: Date.now() },
  );
}

// Admits an occurrence and its run the way the isolated executor does.
async function admitRun(stored: CronStoredJob) {
  const occurrence = await admitScheduledOccurrence({
    cfg: CFG,
    job: stored,
    agentId: "main",
    trigger: "cron",
  });
  const scheduledExecution = occurrence.mint({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    runSessionKey: RUN_KEY,
    toolsAllow: TOOLS_ALLOW,
  });
  const admission = prepareCronRunAdmission({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    sessionKey: RUN_KEY,
    jobId: stored.id,
    deliveryAttemptFence: null,
    scheduledExecution,
  });
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  // The executor's one sender bit for every runtime candidate.
  const result = scheduledExecution.result;
  if (result.status !== "ready") {
    throw new Error(`expected a ready context, got ${result.status}`);
  }
  return {
    admitted,
    senderIsOwner: resolveScheduledSenderBit(result)?.senderIsOwner,
    settle: () => {
      admission.close();
      occurrence.release();
    },
  };
}

// The admitted run, with the sender bit widened so a control can pass an explicit owner.
type Run = Omit<Awaited<ReturnType<typeof admitRun>>, "senderIsOwner"> & {
  senderIsOwner?: boolean;
};

// The embedded attempt builds its tools from the run's sender bit.
async function embeddedTools(run: Run) {
  return await createOpenClawCodingToolsInternalAsync({
    config: CFG,
    agentId: "main",
    sessionKey: RUN_KEY,
    sessionId: "run-session",
    runId: "run-1",
    trigger: "cron",
    jobId: "job-1",
    operationalRunInstance: run.admitted.operationalRunInstance,
    ...(run.senderIsOwner !== undefined ? { senderIsOwner: run.senderIsOwner } : {}),
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: true,
    },
  });
}

// Codex builds its dynamic tools through the harness host from the same attempt bit;
// the host stays open while the tools are probed.
async function codexOwnerOnly(run: Run) {
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: "codex-run",
    agentId: "main",
    sessionId: "run-session",
    sessionKey: RUN_KEY,
    workspaceDir: "/workspace",
    config: CFG,
  });
  try {
    const tools =
      (await host.hostCapabilities.createToolSurfaceAsync?.({
        sessionKey: RUN_KEY,
        trigger: "cron",
        jobId: "job-1",
        ...(run.senderIsOwner !== undefined ? { senderIsOwner: run.senderIsOwner } : {}),
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: true,
        },
      })) ?? [];
    return await callableOwnerOnly(tools);
  } finally {
    host.closeHost();
    host.closeAdmission();
  }
}

// The CLI grant coerces the run's bit to a boolean; the loopback resolves the tools.
async function cliTools(run: Run) {
  const scoped = await resolveGatewayScopedTools({
    cfg: CFG,
    sessionKey: RUN_KEY,
    sessionId: "run-session",
    runId: "run-1",
    senderIsOwner: run.senderIsOwner === true,
    surface: "loopback",
    admittedRunContext: run.admitted,
    toolsAllow: TOOLS_ALLOW,
  });
  return scoped.tools;
}

// A gated owner-only tool keeps its definition and answers with a turn-authority refusal.
async function isOwnerGated(tool: AnyAgentTool): Promise<boolean> {
  try {
    const result = await tool.execute("probe", {}, undefined, undefined);
    return (result.details as { gated?: boolean } | undefined)?.gated === true;
  } catch {
    return false;
  }
}

async function callableOwnerOnly(tools: readonly AnyAgentTool[]) {
  const names: string[] = [];
  for (const tool of tools) {
    if (OWNER_ONLY.has(tool.name) && !(await isOwnerGated(tool))) {
      names.push(tool.name);
    }
  }
  return names.toSorted();
}

describe("scheduled owner authority", () => {
  it.each(PRINCIPALS)(
    "$name gets the same owner-only tools on embedded, Codex and CLI runs",
    async (principal) => {
      seedParent();
      profile.current = "profileCurrent" in principal ? principal.profileCurrent : true;
      const run = await admitRun(principal.job);
      expect(run.senderIsOwner).toBe(principal.senderIsOwner);
      const embedded = await callableOwnerOnly(await embeddedTools(run));
      const codex = await codexOwnerOnly(run);
      const cli = await callableOwnerOnly(await cliTools(run));
      expect(codex).toEqual(embedded);
      // The CLI loopback has no self-scoped automations grant yet (phase 4); every
      // other owner-only decision matches the embedded run.
      expect(cli).not.toContain(AUTOMATIONS_TOOL_NAME);
      expect(cli).toEqual(embedded.filter((name) => name !== AUTOMATIONS_TOOL_NAME));
      // No scheduled run carries the explicit owner identity standing intents need.
      expect(embedded).not.toContain("intent");
      if (principal.senderIsOwner === false) {
        // A non-owner requester keeps only the scoped sessions and automations grants.
        expect(embedded).toEqual([AUTOMATIONS_TOOL_NAME, "sessions"]);
      } else {
        expect(embedded).toEqual(expect.arrayContaining(["gateway", "nodes", "sessions"]));
      }
      run.settle();
    },
  );

  it("offers the intent stand-in only to an explicit owner identity", async () => {
    seedParent();
    const run = await admitRun(job({ ...linked, createdActor: PROFILE }));
    // Control: the same construction with an explicit owner bit offers intent, so its
    // absence above is the sender bit, not the fixture.
    const explicitOwner = await callableOwnerOnly(
      await embeddedTools({ ...run, senderIsOwner: true }),
    );
    expect(explicitOwner).toContain("intent");
    run.settle();
  });

  it("refuses an owner-only call once the requester stops being an owner mid-run", async () => {
    seedParent();
    const run = await admitRun(job({ ...linked, createdActor: PROFILE }));
    expect(run.senderIsOwner).toBeUndefined();
    for (const tools of [await embeddedTools(run), await cliTools(run)]) {
      profile.current = true;
      const gateway = tools.find((tool) => tool.name === "gateway")!;
      // While the requester is current the call passes the owner recheck.
      const current = await gateway
        .execute("current", { action: "config.get" }, undefined, undefined)
        .then(
          () => "",
          (error: unknown) => String(error),
        );
      expect(current).not.toMatch(/no longer an owner/);
      profile.current = false;
      await expect(
        gateway.execute("revoked", { action: "config.get" }, undefined, undefined),
      ).rejects.toThrow(/no longer an owner/);
    }
    run.settle();
  });

  it("leaves in-session and ingress runs to their existing sender check", () => {
    // Only these fields decide the sender bit.
    const ready = (facts: Pick<ScheduledExecutionFacts, "authority" | "placement" | "principal">) =>
      ({ status: "ready", facts }) as ScheduledExecutionContextResult;
    const authority = { owner: true, basis: "profile-role" } as const;
    const parent = {
      kind: "parent",
      parent: { agentId: "main", sessionKey: PARENT_KEY, sessionId: "parent-session" },
      requester: { kind: "profile", profileId: PROFILE.id },
    } as const;
    expect(
      resolveScheduledSenderBit(ready({ authority, placement: "in-session", principal: parent })),
    ).toBeUndefined();
    expect(
      resolveScheduledSenderBit(
        ready({
          authority: { owner: false, basis: "none" },
          placement: "detached",
          principal: { kind: "ingress", ingress: "webhook" },
        }),
      ),
    ).toBeUndefined();
    expect(
      resolveScheduledSenderBit(ready({ authority, placement: "child", principal: parent })),
    ).toEqual({});
  });
});
