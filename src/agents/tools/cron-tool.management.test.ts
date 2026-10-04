import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
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
  it.each(["channel-owner", "unknown"] as const)(
    "permits %s command edits without recapturing creator authority",
    async (origin) => {
      await withAdminTool(origin, async (tool, calls) => {
        const patch = {
          payload: { kind: "command", argv: ["printf", "proof"], timeoutSeconds: 30 },
        };
        await expect(
          tool.execute("command-update", { action: "update", jobId, job: patch }),
        ).resolves.toMatchObject({ details: { id: jobId } });
        expect(calls).toEqual([
          ["cron.get", { id: jobId }],
          ["cron.update", { id: jobId, expectedConfigRevision: configRevision, patch }],
        ]);
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

  it("advertises only admitted management actions and inputs", async () => {
    await withAdminTool("unknown", async (tool) => {
      const actions = ["list", "get", "update", "run", "remove"];
      expect(tool.parameters).toHaveProperty("properties.action.enum", actions);
      for (const key of ["in", "text", "mode", "contextMessages", "sessionKey"]) {
        expect(tool.parameters).not.toHaveProperty(`properties.${key}`);
      }
      expect(tool.parameters).not.toHaveProperty("properties.job.properties.declarationKey");
      expect(tool.parameters).toHaveProperty("properties.job.properties.agentId");
    });
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
