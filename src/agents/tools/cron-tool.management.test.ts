import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import * as runRegistry from "../../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { createCronTool } from "./cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import * as gatewayModule from "./gateway.js";

const jobId = "existing-job";
const configRevision = "sha256:stored-job";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(clearRuntimeConfigSnapshot);

async function withAdminTool(
  origin: "unknown" | "channel-owner",
  payload: Record<string, unknown> | undefined,
  run: (tool: ReturnType<typeof createCronTool>, calls: Array<[string, unknown]>) => Promise<void>,
) {
  const runId = "admin-management-tool-run";
  const sessionKey = "agent:main:control-ui";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = runRegistry.claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = createCronCreatorAuthorityCapability(
    runId,
    origin === "channel-owner" ? { kind: "external", channel: "discord" } : { kind: origin },
    origin === "channel-owner"
      ? { source: "channel-owner", isCurrent: () => true }
      : { source: "control-ui-admin" },
  )!;
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey,
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  const calls: Array<[method: string, params: unknown]> = [];
  const resolveCreatorToolAuthority = vi.fn(async () => {
    throw new Error("Admin management must not recapture the creator's tool authority");
  });
  async function callGatewayTool<T>(method: string, _options: unknown, params: unknown) {
    const caller = getGatewayToolCallerIdentity();
    expect(caller?.cronCreatorAuthorityGrant).toBeUndefined();
    expect(caller?.cronManagementGrant).toBeDefined();
    return withCronManagementGrant(caller!.cronManagementGrant!, identity, method, async () => {
      getCronManagementAuthority(identity)!();
      calls.push([method, params]);
      return (method === "cron.get" ? { id: jobId, configRevision, payload } : { id: jobId }) as T;
    });
  }
  try {
    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        const options = { runId, agentSessionKey: sessionKey, resolveCreatorToolAuthority };
        using _ = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(callGatewayTool);
        const tool = createCronTool(options);
        await run(tool, calls);
        expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
      }),
    );
  } finally {
    runRegistry.releaseAgentRunDelegatedAuthority(authority);
  }
}

const command = { kind: "command", argv: ["printf", "proof"] };
it.each([
  { origin: "channel-owner", input: { ...command, timeoutSeconds: 30 }, stored: undefined },
  { origin: "unknown", input: { timeoutSeconds: null }, stored: command },
] as const)("edits commands ($origin)", async ({ origin, input, stored }) => {
  await withAdminTool(origin, stored, async (tool, calls) => {
    await expect(
      tool.execute("update", { action: "update", jobId, job: { payload: input } }),
    ).resolves.toMatchObject({ details: { id: jobId } });
    const patch = { payload: stored ? { kind: "command", timeoutSeconds: null } : input };
    const params = {
      id: jobId,
      patch,
      ...(stored ? { expectedConfigRevision: configRevision } : {}),
    };
    expect(calls).toEqual([
      ...(stored ? [["cron.get", { id: jobId }]] : []),
      ["cron.update", params],
    ]);
  });
});

it("visibly refuses unsupported next_check", async () => {
  await withAdminTool("unknown", undefined, async (tool, calls) => {
    await expect(tool.execute("unsupported", { action: "next_check", in: "1m" })).rejects.toThrow(
      "Use the Automations page for other actions",
    );
    expect(calls).toEqual([]);
  });
});

describe("cron next_check action", () => {
  const RUN_ID = "paced-run";
  const JOB_ID = "paced-job";
  let runClaimId: string | undefined;

  afterEach(() => {
    runRegistry.releaseAgentRunContext(RUN_ID, runClaimId);
    runRegistry.clearAgentRunContext(RUN_ID);
    runClaimId = undefined;
  });

  function nextCheck(scopedJobId: string | null = JOB_ID, delay = "15m") {
    const opts = scopedJobId ? { selfRemoveOnlyJobId: scopedJobId, runId: RUN_ID } : undefined;
    const tool = createCronTool(opts);
    return tool.execute("call-next-check", { action: "next_check", in: delay });
  }

  function registerRun(nextCheckEnabled: boolean) {
    runClaimId = runRegistry.claimAgentRunContext(
      RUN_ID,
      {
        sessionKey: `agent:main:cron:${JOB_ID}`,
        cronRunsByJobId: new Map([[JOB_ID, { nextCheckEnabled }]]),
      },
      { trackOwner: true, ownsContext: true },
    );
  }

  it("rejects a proposal when the current job does not admit next_check", async () => {
    registerRun(false);

    await expect(nextCheck()).rejects.toThrow(
      "cron next_check requires pacing or a one-shot session continuation",
    );
  });

  it("rejects next_check outside a current cron run", async () => {
    await expect(nextCheck(null)).rejects.toThrow(
      "cron next_check is only available to the currently running job",
    );
  });

  it("keeps proposals isolated when a shared run context adds another job", async () => {
    registerRun(true);
    await nextCheck();

    runRegistry.claimAgentRunContext(RUN_ID, {
      cronRunsByJobId: new Map([["next-job", { nextCheckEnabled: true }]]),
    });
    await nextCheck("next-job", "30m");

    expect(runRegistry.consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(15 * 60_000);
    expect(runRegistry.consumeCronNextCheckProposal(RUN_ID, "next-job")).toBe(30 * 60_000);
  });
});
