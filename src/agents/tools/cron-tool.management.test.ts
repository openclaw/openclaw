import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
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

const jobId = "existing-job";
const configRevision = "sha256:stored-job";

async function withAdminTool(
  origin: "unknown" | "channel-owner",
  run: (tool: ReturnType<typeof createCronTool>, calls: Array<[string, unknown]>) => Promise<void>,
  payload?: Record<string, unknown>,
) {
  const runId = "admin-management-tool-run";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
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
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  const calls: Array<[method: string, params: unknown]> = [];
  const resolveCreator = vi.fn(async () => {
    throw new Error("Admin management must not recapture the creator's tool authority");
  });
  try {
    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        const tool = createCronTool(
          {
            runId,
            agentSessionKey: identity.sessionKey,
            resolveCreatorToolAuthority: resolveCreator,
          },
          {
            callGatewayTool: async <T>(method: string, _options: unknown, params: unknown) => {
              const caller = getGatewayToolCallerIdentity();
              expect(caller?.cronCreatorAuthorityGrant).toBeUndefined();
              expect(caller?.cronManagementGrant).toBeDefined();
              return await withCronManagementGrant(
                caller!.cronManagementGrant!,
                identity,
                method,
                async () => {
                  getCronManagementAuthority(identity)!();
                  calls.push([method, params]);
                  return (
                    method === "cron.get" ? { id: jobId, configRevision, payload } : { id: jobId }
                  ) as T;
                },
              );
            },
          },
        );
        await run(tool, calls);
        expect(resolveCreator).not.toHaveBeenCalled();
      }),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("admin automation management", () => {
  it.each(["channel-owner"] as const)(
    "permits %s command edits without recapturing creator authority",
    async (origin) => {
      await withAdminTool(origin, async (tool, calls) => {
        const patch = {
          payload: { kind: "command", argv: ["printf", "proof"], timeoutSeconds: 30 },
        };
        await expect(
          tool.execute("command-update", { action: "update", jobId, job: patch }),
        ).resolves.toMatchObject({ details: { id: jobId } });
        expect(calls).toEqual([["cron.update", { id: jobId, patch }]]);
      });
    },
  );

  it("inherits a stored command kind when clearing its timeout", async () => {
    await withAdminTool(
      "unknown",
      async (tool, calls) => {
        await tool.execute("timeout-update", {
          action: "update",
          jobId,
          job: { payload: { timeoutSeconds: null } },
        });
        expect(calls).toEqual([
          ["cron.get", { id: jobId }],
          [
            "cron.update",
            {
              id: jobId,
              expectedConfigRevision: configRevision,
              patch: { payload: { kind: "command", timeoutSeconds: null } },
            },
          ],
        ]);
      },
      { kind: "command", argv: ["printf", "proof"] },
    );
  });

  it("visibly refuses unsupported next_check", async () => {
    await withAdminTool("unknown", async (tool, calls) => {
      await expect(tool.execute("unsupported", { action: "next_check", in: "1m" })).rejects.toThrow(
        "Use the Automations page for other actions",
      );
      expect(calls).toEqual([]);
    });
  });
});

describe("cron next_check action", () => {
  const RUN_ID = "paced-run";
  const JOB_ID = "paced-job";

  afterEach(() => {
    clearAgentRunContext(RUN_ID);
  });

  function createScopedTool(scopedJobId = JOB_ID) {
    return createCronTool(
      { selfRemoveOnlyJobId: scopedJobId, runId: RUN_ID },
      { callGatewayTool: vi.fn() },
    );
  }

  function registerRun(pacingEnabled: boolean) {
    claimAgentRunContext(RUN_ID, {
      sessionKey: `agent:main:cron:${JOB_ID}`,
      cronRunsByJobId: new Map([[JOB_ID, { pacingEnabled, assertCurrent: () => {} }]]),
    });
  }

  it("rejects a proposal when the current job has no pacing", async () => {
    registerRun(false);

    await expect(
      createScopedTool().execute("call-next-check", { action: "next_check", in: "15m" }),
    ).rejects.toThrow("cron next_check requires pacing on the current job");
  });

  it("rejects next_check outside a current cron run", async () => {
    const tool = createCronTool(undefined, { callGatewayTool: vi.fn() });

    await expect(
      tool.execute("call-next-check-unscoped", { action: "next_check", in: "15m" }),
    ).rejects.toThrow("cron next_check is only available to the currently running job");
  });

  it("keeps proposals isolated when a shared run context adds another job", async () => {
    registerRun(true);
    await createScopedTool().execute("call-next-check-stale", {
      action: "next_check",
      in: "15m",
    });

    claimAgentRunContext(RUN_ID, {
      cronRunsByJobId: new Map([["next-job", { pacingEnabled: true, assertCurrent: () => {} }]]),
    });
    await createScopedTool("next-job").execute("call-next-check-next-job", {
      action: "next_check",
      in: "30m",
    });

    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(15 * 60_000);
    expect(consumeCronNextCheckProposal(RUN_ID, "next-job")).toBe(30 * 60_000);
  });
});
