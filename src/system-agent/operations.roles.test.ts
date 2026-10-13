import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentRole } from "../agents/agent-roles.js";
import { loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import {
  createSystemAgentTool,
  type SystemAgentToolDirective,
} from "../agents/tools/system-agent-tool.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as agentProvenance from "../state/agent-provenance.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { withEnvAsync } from "../test-utils/env.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  parseSystemAgentOperation,
  type SystemAgentOperation,
} from "./operations.js";
import type { SystemAgentProposalRef } from "./operator-approval.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function withState(run: (root: string, configPath: string) => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-custodian-roles-" }, async (root) => {
    const configPath = path.join(root, "openclaw.json");
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: undefined,
        OPENCLAW_HOME: root,
      },
      async () => {
        resetConfigRuntimeState();
        try {
          await fs.writeFile(
            configPath,
            JSON.stringify({
              agents: {
                ownership: "explicit",
                entries: { ambient: { workspace: path.join(root, "ambient") } },
              },
            }),
          );
          await run(root, configPath);
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          resetConfigRuntimeState();
        }
      },
    );
  });
}

async function readConfig(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  return snapshot.sourceConfig ?? snapshot.config;
}

describe("custodian role creation through persisted configuration", () => {
  it.each<{
    source: "command" | "tool";
    agentId: string;
    role?: "writer";
  }>([
    { source: "command", agentId: "ledger" },
    { source: "tool", agentId: "qa-writer" },
    { source: "tool", agentId: "qa-writer", role: "writer" },
  ])(
    "creates $agentId from $source with role=$role only after approval",
    async ({ source, agentId, role }) => {
      await withState(async (root, configPath) => {
        const workspace = path.join(root, agentId);
        const purpose = "Check arithmetic in synthetic order lists.";
        const original = await fs.readFile(configPath, "utf8");
        const { runtime, lines } = createSystemAgentTestRuntime();
        let operation: SystemAgentOperation =
          source === "command"
            ? parseSystemAgentOperation(
                `create agent ${agentId} purpose "${purpose}" workspace "${workspace}"`,
              )
            : { kind: "create-agent", agentId, workspace, ...(role ? { role } : { purpose }) };
        if (source === "tool") {
          const args = {
            action: "create_agent",
            agentId,
            name: "QA Writer",
            workspace,
            ...(role ? { role } : { purpose }),
          };
          const proposalRef: SystemAgentProposalRef = {};
          const directiveRef: { current?: SystemAgentToolDirective } = {};
          const tool = createSystemAgentTool({ surface: "gateway", proposalRef, directiveRef });
          await tool.execute("propose", args);
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          const approvedTool = createSystemAgentTool({
            surface: "gateway",
            approvalArmed: true,
            proposalRef,
            directiveRef,
          });
          await approvedTool.execute("approve", { ...args, approved: true });
          const directive = directiveRef.current;
          expect(directive?.kind).toBe("approved-operation");
          if (directive?.kind !== "approved-operation") {
            throw new Error("missing approved creation operation");
          }
          operation = directive.operation;
          expect(describeSystemAgentPersistentOperation(operation)).toContain('name: "QA Writer"');
          expect(tool.parameters).toMatchObject({ properties: { name: { type: "string" } } });
        } else {
          expect(await executeSystemAgentOperation(operation, runtime)).toMatchObject({
            applied: false,
            ...(role ? { message: expect.stringContaining("Writer") } : {}),
          });
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const result = await executeSystemAgentOperation(operation, runtime, {
          approved: true,
        });
        expect(result).toMatchObject({ applied: true, agentId });
        const config = await readConfig();
        const entry = config.agents?.entries?.[agentId];
        expect(entry?.workspace).toBe(workspace);
        if (source === "tool") {
          expect(entry).toMatchObject({
            name: "QA Writer",
            identity: { name: "QA Writer" },
            workspace,
          });
          expect(lines.join("\n")).toContain("Created agent QA Writer (qa-writer)");
        }
        if (!role) {
          expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(purpose);
          expect(describeSystemAgentPersistentOperation(operation)).toContain(
            `purpose: ${JSON.stringify(purpose)}`,
          );
          if (source === "command") {
            return;
          }
          expect(result).toMatchObject({ bootstrapPending: true });
          expect(await fs.readFile(path.join(workspace, "BOOTSTRAP.md"), "utf8")).not.toHaveLength(
            0,
          );
          expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).not.toContain(
            "QA Writer",
          );
          // Completing the identity ceremony must not consume the agent's operating purpose.
          await fs.writeFile(
            path.join(workspace, "IDENTITY.md"),
            "# Identity\n\n- **Name:** QA Writer\n",
          );
          await fs.unlink(path.join(workspace, "BOOTSTRAP.md"));
          await expect(
            ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true }),
          ).resolves.toMatchObject({ bootstrapPending: false });
          expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(purpose);
        } else {
          const template = await loadAgentRole(role);
          expect(entry?.identity).toEqual({ ...template.identity, name: "QA Writer" });
          expect(loadAgentIdentityFromWorkspace(workspace)).toMatchObject({
            ...template.identity,
            name: "QA Writer",
          });
          expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
            template.files["AGENTS.md"],
          );
        }
      });
    },
  );

  it("requires fresh approval when a custom purpose changes", async () => {
    await withState(async (root, configPath) => {
      const args = {
        action: "create_agent",
        agentId: "ledger",
        workspace: path.join(root, "ledger"),
        purpose: "Check arithmetic in synthetic order lists.",
      };
      const proposalRef: SystemAgentProposalRef = {};
      const directiveRef: { current?: SystemAgentToolDirective } = {};
      const tool = createSystemAgentTool({ surface: "gateway", proposalRef, directiveRef });
      const original = await fs.readFile(configPath, "utf8");
      await tool.execute("propose", args);
      const approvedTool = createSystemAgentTool({
        surface: "gateway",
        approvalArmed: true,
        proposalRef,
        directiveRef,
      });
      await approvedTool.execute("approve-changed", {
        ...args,
        purpose: "Send invoices to customers.",
        approved: true,
      });
      expect(directiveRef.current).toBeUndefined();
      expect(proposalRef.current).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(fs.access(args.workspace)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves existing instructions", async () => {
    await withState(async (root, configPath) => {
      const workspace = path.join(root, "existing");
      await fs.mkdir(workspace);
      const instructions = "# Existing instructions\n\nKeep the operator's workflow.\n";
      await fs.writeFile(path.join(workspace, "AGENTS.md"), instructions);
      const original = await fs.readFile(configPath, "utf8");
      const { runtime } = createSystemAgentTestRuntime();
      await expect(
        executeSystemAgentOperation(
          {
            kind: "create-agent",
            agentId: "ledger",
            workspace,
            purpose: "Check arithmetic in synthetic order lists.",
          },
          runtime,
          { approved: true },
        ),
      ).rejects.toThrow("Existing AGENTS.md was preserved");
      expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(instructions);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(await fs.readdir(workspace)).toEqual(["AGENTS.md"]);
    });
  });

  it("creates the approved team with directed delegation and separate role workspaces", async () => {
    await withState(async (root, configPath) => {
      const workspaceRoot = path.join(root, "team");
      const operation = {
        kind: "create-team" as const,
        coordinatorId: "lead",
        prefix: "docs",
        workspaceRoot,
      };
      const original = await fs.readFile(configPath, "utf8");
      const { runtime, lines } = createSystemAgentTestRuntime();
      const proposal = await executeSystemAgentOperation(operation, runtime);
      expect(proposal).toMatchObject({
        applied: false,
        message: expect.stringContaining("team of 4: chief of staff, researcher, writer, reviewer"),
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(fs.access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const result = await executeSystemAgentOperation(operation, runtime, {
        approved: true,
        requesterAgentId: "planner",
      });
      expect(result).toMatchObject({
        applied: true,
        agentId: "docs-lead",
        bootstrapPending: false,
      });
      const config = await readConfig();
      const members = [
        ["docs-lead", "coordinator"],
        ["docs-researcher", "researcher"],
        ["docs-writer", "writer"],
        ["docs-reviewer", "reviewer"],
      ] as const;
      expect(Object.keys(config.agents?.entries ?? {})).toEqual([
        "ambient",
        ...members.map(([id]) => id),
      ]);
      for (const [id, role] of members) {
        const workspace = path.join(workspaceRoot, id);
        const template = await loadAgentRole(role);
        expect(config.agents?.entries?.[id]).toMatchObject({
          workspace,
          identity: template.identity,
        });
        expect(readAgentProvenance(id)).toMatchObject({
          createdVia: "agent",
          creatorAgentId: "planner",
        });
        expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
          template.files["AGENTS.md"],
        );
        await expect(fs.access(path.join(workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(config.agents?.entries?.["docs-lead"]?.subagents).toEqual({
        allowAgents: ["docs-researcher", "docs-writer", "docs-reviewer"],
        delegationMode: "prefer",
      });
      expect(config.agents?.defaults?.systemAgent?.agentId).toBe("docs-lead");
      const confirmation = lines.join("\n");
      expect(confirmation).toContain("docs-lead");
      expect(confirmation).toContain("Agents home");
      expect(confirmation).toContain("agent switcher");
    });
  });

  it.each(["unfinished-bootstrap", "authority-revoked", "post-commit-first"])(
    "reports and audits retained members after %s blocks the remaining team",
    async (failure) => {
      await withState(async (root) => {
        const workspaceRoot = path.join(root, "team");
        const retainedAgentIds =
          failure === "post-commit-first" ? ["coordinator"] : ["coordinator", "researcher"];
        let researcherRecorded = false;
        const recordProvenance = agentProvenance.recordAgentProvenance;
        vi.spyOn(agentProvenance, "recordAgentProvenance").mockImplementation((...args) => {
          if (failure === "post-commit-first" && args[0] === "coordinator") {
            throw new Error("provenance unavailable");
          }
          const result = recordProvenance(...args);
          researcherRecorded ||= args[0] === "researcher";
          return result;
        });
        if (failure === "unfinished-bootstrap") {
          const unfinished = await ensureAgentWorkspace({
            dir: path.join(workspaceRoot, "writer"),
            ensureBootstrapFiles: true,
          });
          expect(unfinished.bootstrapPending).toBe(true);
        }
        const { runtime, lines } = createSystemAgentTestRuntime();

        const result = await executeSystemAgentOperation(
          { kind: "create-team", workspaceRoot },
          runtime,
          {
            approved: true,
            beforePersistentApply: () => {
              if (failure === "authority-revoked" && researcherRecorded) {
                throw new Error("authority closed");
              }
            },
          },
        );

        expect(result).toMatchObject({ applied: true });
        const config = await readConfig();
        expect(Object.keys(config.agents?.entries ?? {})).toEqual(["ambient", ...retainedAgentIds]);
        const output = lines.join("\n");
        expect(output).toContain("Team creation incomplete");
        for (const id of retainedAgentIds) {
          const workspace = path.join(workspaceRoot, id);
          expect(config.agents?.entries?.[id]?.workspace).toBe(workspace);
          expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
            (await loadAgentRole(id)).files["AGENTS.md"],
          );
          expect(output).toContain(id);
        }
        expect(output).toContain(
          failure === "unfinished-bootstrap"
            ? "unfinished bootstrap"
            : failure === "authority-revoked"
              ? "authority closed"
              : "provenance unavailable",
        );
        expect(output).not.toContain("Created team:");
        expect(listSystemAgentAuditEntriesForTests().at(-1)?.value).toMatchObject({
          operation: "agents.createTeam",
          summary: expect.stringContaining("Team creation incomplete"),
          details: { retainedAgentIds },
        });
        await expect(fs.access(path.join(workspaceRoot, "reviewer"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );
});
