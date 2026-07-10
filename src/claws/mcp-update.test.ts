import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyClawMcpUpdate } from "./mcp-update.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  digestClawMcpServer,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import { CLAW_OUTPUT_STABILITY, type ClawManifest, type ClawMcpServer } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

const oldDocs: ClawMcpServer = { command: "uvx", args: ["docs@1"] };
const newDocs: ClawMcpServer = { command: "uvx", args: ["docs@2"] };
const legacy: ClawMcpServer = { command: "node", args: ["legacy.mjs"] };
const remote: ClawMcpServer = {
  url: "https://example.com/mcp",
  transport: "streamable-http",
  auth: "oauth",
};

function ref(name: string, server: ClawMcpServer): PersistedClawMcpServerRef {
  return {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: "worker",
    name,
    configDigest: digestClawMcpServer(server),
    status: "complete",
    createdAtMs: 10,
    updatedAtMs: 10,
  };
}

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:new" },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: actions.filter((action) => action.action === "change").length,
      removed: actions.filter((action) => action.action === "remove").length,
      unchanged: 0,
      manual: 0,
      blocked: 0,
    },
    actions,
    blockers: [],
    diagnostics: [],
  };
}

function manifest(): ClawManifest {
  return {
    schemaVersion: 1,
    agent: { id: "worker" },
    workspace: { bootstrapFiles: {}, files: [] },
    packages: [],
    mcpServers: { docs: newDocs, remote },
    cronJobs: [],
  };
}

describe("applyClawMcpUpdate", () => {
  it("applies add, change, and remove with CAS writes and reversible ownership", async () => {
    const currentRefs = [ref("docs", oldDocs), ref("legacy", legacy)];
    const setServer = vi.fn(async () => ({
      ok: true as const,
      path: "config",
      config: {},
      mcpServers: {},
    }));
    const unsetServer = vi.fn(async () => ({
      ok: true as const,
      path: "config",
      config: {},
      mcpServers: {},
      removed: true,
    }));
    const upsertRef = vi.fn();
    const deleteRef = vi.fn();
    const execution = await applyClawMcpUpdate(
      plan([
        {
          kind: "mcpServer",
          id: "docs",
          action: "change",
          target: "mcp.servers.docs",
          blocked: false,
          reason: "changed",
        },
        {
          kind: "mcpServer",
          id: "remote",
          action: "add",
          target: "mcp.servers.remote",
          blocked: false,
          reason: "added",
        },
        {
          kind: "mcpServer",
          id: "legacy",
          action: "remove",
          target: "mcp.servers.legacy",
          blocked: false,
          reason: "removed",
        },
      ]),
      manifest(),
      {
        config: { mcp: { servers: { docs: oldDocs, legacy } } } as OpenClawConfig,
        nowMs: 20,
        readRefs: () => currentRefs,
        setServer,
        unsetServer,
        upsertRef,
        deleteRef,
      },
    );

    expect(execution.appliedNames).toEqual(["docs", "remote", "legacy"]);
    expect(setServer).toHaveBeenNthCalledWith(1, {
      name: "docs",
      server: newDocs,
      expectedServer: oldDocs,
    });
    expect(setServer).toHaveBeenNthCalledWith(2, {
      name: "remote",
      server: remote,
      createOnly: true,
    });
    expect(unsetServer).toHaveBeenCalledWith({ name: "legacy", expectedServer: legacy });

    await execution.rollback();

    expect(setServer).toHaveBeenNthCalledWith(3, {
      name: "legacy",
      server: legacy,
      createOnly: true,
    });
    expect(unsetServer).toHaveBeenNthCalledWith(2, {
      name: "remote",
      expectedServer: remote,
    });
    expect(setServer).toHaveBeenNthCalledWith(4, {
      name: "docs",
      server: oldDocs,
      expectedServer: newDocs,
    });
    expect(upsertRef).toHaveBeenCalledTimes(4);
    expect(deleteRef).toHaveBeenCalledTimes(2);
  });

  it("does not compensate a config write rejected before mutation", async () => {
    const setServer = vi.fn(async () => ({ ok: false as const, path: "config", error: "changed" }));
    const unsetServer = vi.fn();

    await expect(
      applyClawMcpUpdate(
        plan([
          {
            kind: "mcpServer",
            id: "docs",
            action: "change",
            target: "mcp.servers.docs",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest(),
        {
          config: { mcp: { servers: { docs: oldDocs } } },
          readRefs: () => [ref("docs", oldDocs)],
          setServer,
          unsetServer,
        },
      ),
    ).rejects.toThrow("changed");
    expect(setServer).toHaveBeenCalledTimes(1);
    expect(unsetServer).not.toHaveBeenCalled();
  });

  it("does not overwrite an unowned server that appears before apply", async () => {
    const setServer = vi.fn();
    await expect(
      applyClawMcpUpdate(
        plan([
          {
            kind: "mcpServer",
            id: "remote",
            action: "add",
            target: "mcp.servers.remote",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          config: { mcp: { servers: { remote } } },
          readRefs: () => [],
          setServer,
        },
      ),
    ).rejects.toThrow("was not claimed");
    expect(setServer).not.toHaveBeenCalled();
  });
});
