import { describe, expect, it, vi } from "vitest";
import { createCronTool, replaceWithEffectiveCronCreatorToolAllowlist } from "./cron-tool.js";
import type { CronCreatorToolAllowlistEntry, GatewayToolCaller } from "./cron-tool.types.js";

const diagnosticNotice = "unrelated: requires OAuth; run openclaw mcp login unrelated";

function createHarness(interactiveMcp = false) {
  const callGateway = vi.fn((...[method]: Parameters<GatewayToolCaller>) => {
    const result =
      method === "cron.get"
        ? {
            id: "existing-job",
            configRevision: "sha256:before",
            payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
          }
        : { id: "saved-job" };
    return result;
  });
  const resolveCreatorToolAuthority = vi.fn(async () => ({
    tools: ["read", "exec"],
    provenance: { version: 1 as const, source: "final-executable-surface" as const },
    diagnosticNotice,
    grant: { runId: "run-exclusions", token: "synthetic-unit-grant" },
  }));
  const creatorToolAllowlist: CronCreatorToolAllowlistEntry[] = ["read", "exec"];
  if (interactiveMcp) {
    replaceWithEffectiveCronCreatorToolAllowlist(
      creatorToolAllowlist,
      ["read", "exec", "unrelated__lookup"].map((name) => ({ name })),
      (tool) =>
        tool.name === "unrelated__lookup"
          ? { pluginId: "bundle-mcp", mcp: { serverName: "unrelated" } }
          : undefined,
    );
  }
  const tool = createCronTool(
    {
      agentSessionKey: "agent:main:main",
      creatorToolAllowlist,
      resolveCreatorToolAuthority,
    },
    {
      callGatewayTool: async <T>(...args: Parameters<GatewayToolCaller>) =>
        callGateway(...args) as T,
    },
  );
  const job = {
    name: "Local work",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    delivery: { mode: "none" },
    payload: { kind: "agentTurn", message: "Local work" },
  };
  return { tool, callGateway, resolveCreatorToolAuthority, job };
}

describe("automation creator authority exclusions", () => {
  it.each(["add", "update"])(
    "reports exclusions on %s without persisting them as authority",
    async (action) => {
      const { tool, callGateway, resolveCreatorToolAuthority, job } = createHarness();
      const result = await tool.execute("subset", {
        action,
        jobId: "existing-job",
        job: action === "add" ? job : { ...job, payload: { ...job.payload, toolsAllow: ["*"] } },
      });
      expect(result.details).toEqual({ id: "saved-job", warnings: [diagnosticNotice] });
      expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
      const write = callGateway.mock.calls.at(-1)!;
      expect(write[0]).toBe(`cron.${action}`);
      expect(write[2]).toMatchObject(
        action === "add"
          ? { payload: { toolsAllow: ["read", "exec"], toolsAllowIsDefault: true } }
          : { patch: { payload: { toolsAllow: ["read", "exec"], toolsAllowIsDefault: true } } },
      );
      expect(JSON.stringify(write[2])).not.toContain(diagnosticNotice);
    },
  );

  it.each([
    ["add", false, false],
    ["update", false, false],
    ["add", true, false],
    ["update", true, false],
    ["add", false, true],
    ["update", false, true],
  ] as const)(
    "rejects required unavailable MCP on %s (interactive=%s, wildcard=%s)",
    async (action, interactiveMcp, wildcard) => {
      const { tool, callGateway, job } = createHarness(interactiveMcp);
      await expect(
        tool.execute("required-mcp", {
          action,
          jobId: "existing-job",
          job: {
            ...job,
            payload: {
              ...job.payload,
              toolsAllow: [...(wildcard ? ["*"] : []), "unrelated__lookup"],
            },
          },
        }),
      ).rejects.toThrow(
        /not currently executable: unrelated__lookup.*openclaw mcp login unrelated/,
      );
      expect(callGateway.mock.calls.map((call) => call[0])).toEqual(
        action === "update" ? ["cron.get"] : [],
      );
    },
  );
});
