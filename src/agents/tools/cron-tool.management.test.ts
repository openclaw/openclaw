import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import * as runRegistry from "../../infra/agent-run-registry.js";
import { createCronTool } from "./cron-tool.js";
import { withCronManagementCaller } from "./cron-tool.management.test-support.js";
import type { CronToolOptions } from "./cron-tool.types.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as gatewayModule from "./gateway.js";

const jobId = "existing-job";
const configRevision = "sha256:stored-job";
const getCall = ["cron.get", { id: jobId }];
function updateCalls(patch: Record<string, unknown>, readsCurrent = false) {
  return [
    ...(readsCurrent ? [getCall] : []),
    [
      "cron.update",
      { id: jobId, patch, ...(readsCurrent ? { expectedConfigRevision: configRevision } : {}) },
    ],
  ];
}

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(clearRuntimeConfigSnapshot);

async function withAdminTool(
  origin: "unknown" | "channel-owner",
  payload: Record<string, unknown> | undefined,
  run: (tool: ReturnType<typeof createCronTool>, calls: Array<[string, unknown]>) => Promise<void>,
  storedJob?: Record<string, unknown>,
  creatorOptions: Pick<
    CronToolOptions,
    "config" | "creatorToolAllowlist" | "creatorToolAllowlistCaptureRef"
  > = {},
) {
  const runId = "admin-management-tool-run";
  return withCronManagementCaller(
    runId,
    async (identity) => {
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
          return (
            method === "cron.get"
              ? { id: jobId, configRevision, payload, ...storedJob }
              : { id: jobId }
          ) as T;
        });
      }
      const options = {
        ...creatorOptions,
        runId,
        agentSessionKey: identity.sessionKey,
        resolveCreatorToolAuthority,
      };
      using _ = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(callGatewayTool);
      await run(createCronTool(options), calls);
      expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
    },
    origin,
  );
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
    expect(calls).toEqual(updateCalls(patch, Boolean(stored)));
  });
});

it("permits explicit on-exit edits through admitted management", async () => {
  await withAdminTool("unknown", undefined, async (tool, calls) => {
    const patch = { schedule: { kind: "on-exit", command: "make", cwd: "/repo" } };
    await tool.execute("on-exit-update", { action: "update", jobId, job: patch });
    expect(calls).toEqual(updateCalls(patch));
  });
});

it("does not expose stream creation through a management grant", async () => {
  await withAdminTool("unknown", undefined, async (tool, calls) => {
    await expect(
      tool.execute("stream-add", {
        action: "add",
        job: {
          name: "watch events",
          schedule: { kind: "stream", command: ["node", "events.mjs"] },
          payload: { kind: "agentTurn", message: "handle events" },
        },
      }),
    ).rejects.toThrow("can only list, get, update, run, remove, or bind automations");
    expect(calls).toEqual([]);
  });
});

const completeCapture = { value: { version: 1, source: "final-executable-surface" } } as const;
const execTools: NonNullable<CronToolOptions["creatorToolAllowlist"]> = [
  { name: "exec", execOrigin: "openclaw" },
];
it.each<
  [
    string,
    CronToolOptions["creatorToolAllowlist"],
    CronToolOptions["creatorToolAllowlistCaptureRef"],
    string | undefined,
  ]
>([
  ["complete exec authority", execTools, completeCapture, undefined],
  ["no exec authority", ["read"], completeCapture, "Gateway exec authority"],
  [
    "incomplete executable surface",
    execTools,
    {},
    "did not capture the complete model-callable tool surface",
  ],
])("checks the manager's own stream exec authority: %s", async (_label, tools, capture, error) => {
  const config = { tools: { exec: { host: "gateway", mode: "full" } } } as const;
  setRuntimeConfigSnapshot(config);
  await withAdminTool(
    "unknown",
    undefined,
    async (tool, calls) => {
      const activation = tool.execute("stream-enable", {
        action: "update",
        jobId,
        job: { enabled: true },
      });
      if (error) {
        await expect(activation).rejects.toThrow(error);
        expect(calls).toEqual([getCall]);
      } else {
        await expect(activation).resolves.toMatchObject({ details: { id: jobId } });
        expect(calls).toEqual(updateCalls({ enabled: true }, true));
      }
    },
    {
      enabled: false,
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      state: {},
    },
    { config, creatorToolAllowlist: tools, creatorToolAllowlistCaptureRef: capture },
  );
});

it("limits management authority to its admitted actions", async () => {
  await withAdminTool(
    "unknown",
    undefined,
    async (tool, calls) => {
      const actions = ["list", "get", "update", "run", "remove", "bind"];
      expect(tool.parameters).toHaveProperty("properties.action.enum", actions);
      for (const key of ["in", "text", "mode", "contextMessages", "sessionKey"]) {
        expect(tool.parameters).not.toHaveProperty(`properties.${key}`);
      }
      expect(tool.parameters).not.toHaveProperty("properties.job.properties.declarationKey");
      expect(tool.parameters).toHaveProperty("properties.job.properties.agentId");
      for (const includeDisabled of [false, true]) {
        const result = await tool.execute("manager-inventory", {
          action: "list",
          includeDisabled,
        });
        expect(result.details).toMatchObject({
          scope: "gateway",
          includeDisabled,
          inventoryHint: expect.stringContaining("Absence does not prove deletion"),
        });
      }
      expect((await tool.execute("manager-get", { action: "get", jobId })).details).toMatchObject({
        id: jobId,
      });
      for (const action of ["status", "runs"]) {
        await expect(tool.execute(`manager-${action}`, { action, jobId })).rejects.toThrow(
          "can only list, get, update, run, remove, or bind automations",
        );
      }
      expect(calls).toEqual([
        ["cron.list", { includeDisabled: false, compact: true }],
        ["cron.list", { includeDisabled: true, compact: true }],
        ["cron.get", { id: jobId }],
      ]);
    },
    undefined,
  );
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
        cronRunsByJobId: new Map([[JOB_ID, { nextCheckEnabled, assertCurrent: () => {} }]]),
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
      cronRunsByJobId: new Map([["next-job", { nextCheckEnabled: true, assertCurrent: () => {} }]]),
    });
    await nextCheck("next-job", "30m");

    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(15 * 60_000);
    expect(consumeCronNextCheckProposal(RUN_ID, "next-job")).toBe(30 * 60_000);
  });
});
