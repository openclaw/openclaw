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

const purpose = "Check arithmetic in synthetic order lists.";
const readText = (dir: string, file: string) => fs.readFile(path.join(dir, file), "utf8");
const writeText = (dir: string, file: string, text: string) =>
  fs.writeFile(path.join(dir, file), text);
const expectAbsent = async (file: string) => {
  await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
};
function toolPair() {
  const proposalRef: SystemAgentProposalRef = {};
  const directiveRef: { current?: SystemAgentToolDirective } = {};
  const options = { surface: "gateway" as const, proposalRef, directiveRef };
  return {
    proposalRef,
    directiveRef,
    tool: createSystemAgentTool(options),
    approvedTool: createSystemAgentTool({ ...options, approvalArmed: true }),
  };
}

type State = ReturnType<typeof createSystemAgentTestRuntime> & {
  root: string;
  configPath: string;
  original: string;
};
function withState(run: (state: State) => Promise<void>): Promise<void> {
  return withTestDir({ prefix: "openclaw-custodian-roles-" }, (root) => {
    const configPath = path.join(root, "openclaw.json");
    return withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_WORKSPACE_DIR: undefined,
        OPENCLAW_HOME: root,
      },
      async () => {
        resetConfigRuntimeState();
        try {
          const original = JSON.stringify({
            agents: {
              ownership: "explicit",
              entries: { ambient: { workspace: path.join(root, "ambient") } },
            },
          });
          await fs.writeFile(configPath, original);
          await run({ root, configPath, original, ...createSystemAgentTestRuntime() });
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
    ({ source, agentId, role }) =>
      withState(async ({ root, configPath, original, runtime, lines }) => {
        const workspace = path.join(root, agentId);
        let operation: SystemAgentOperation;
        if (source === "tool") {
          const args = {
            action: "create_agent",
            agentId,
            name: "QA Writer",
            workspace,
            ...(role ? { role } : { purpose }),
          };
          const { tool, approvedTool, directiveRef } = toolPair();
          await tool.execute("propose", args);
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
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
          operation = parseSystemAgentOperation(
            `create agent ${agentId} purpose "${purpose}" workspace "${workspace}"`,
          );
          expect(await executeSystemAgentOperation(operation, runtime)).toMatchObject({
            applied: false,
            ...(role ? { message: expect.stringContaining("Writer") } : {}),
          });
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
          await expectAbsent(workspace);
        }
        const result = await executeSystemAgentOperation(operation, runtime, { approved: true });
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
          expect(await readText(workspace, "AGENTS.md")).toContain(purpose);
          expect(describeSystemAgentPersistentOperation(operation)).toContain(
            `purpose: ${JSON.stringify(purpose)}`,
          );
          if (source === "command") {
            return;
          }
          expect(result).toMatchObject({ bootstrapPending: true });
          expect(await readText(workspace, "BOOTSTRAP.md")).not.toHaveLength(0);
          expect(await readText(workspace, "IDENTITY.md")).not.toContain("QA Writer");
          // Completing the identity ceremony must not consume the agent's operating purpose.
          await writeText(workspace, "IDENTITY.md", "# Identity\n\n- **Name:** QA Writer\n");
          await fs.unlink(path.join(workspace, "BOOTSTRAP.md"));
          await expect(
            ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true }),
          ).resolves.toMatchObject({ bootstrapPending: false });
          expect(await readText(workspace, "AGENTS.md")).toContain(purpose);
        } else {
          const template = await loadAgentRole(role);
          const identity = { ...template.identity, name: "QA Writer" };
          expect(entry?.identity).toEqual(identity);
          expect(loadAgentIdentityFromWorkspace(workspace)).toMatchObject(identity);
          expect(await readText(workspace, "AGENTS.md")).toBe(template.files["AGENTS.md"]);
        }
      }),
  );

  it("requires fresh approval when a custom purpose changes", () =>
    withState(async ({ root, configPath, original }) => {
      const args = {
        action: "create_agent",
        agentId: "ledger",
        workspace: path.join(root, "ledger"),
        purpose,
      };
      const { tool, approvedTool, proposalRef, directiveRef } = toolPair();
      await tool.execute("propose", args);
      await approvedTool.execute("approve-changed", {
        ...args,
        purpose: "Send invoices to customers.",
        approved: true,
      });
      expect(directiveRef.current).toBeUndefined();
      expect(proposalRef.current).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expectAbsent(args.workspace);
    }));

  it("preserves existing instructions", () =>
    withState(async ({ root, configPath, original, runtime }) => {
      const workspace = path.join(root, "existing");
      await fs.mkdir(workspace);
      const instructions = "# Existing instructions\n\nKeep the operator's workflow.\n";
      await writeText(workspace, "AGENTS.md", instructions);
      await expect(
        executeSystemAgentOperation(
          { kind: "create-agent", agentId: "ledger", workspace, purpose },
          runtime,
          { approved: true },
        ),
      ).rejects.toThrow("Existing AGENTS.md was preserved");
      expect(await readText(workspace, "AGENTS.md")).toBe(instructions);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(await fs.readdir(workspace)).toEqual(["AGENTS.md"]);
    }));

  it("creates the approved team with directed delegation and separate role workspaces", () =>
    withState(async ({ root, configPath, original, runtime, lines }) => {
      const workspaceRoot = path.join(root, "team");
      const operation = {
        kind: "create-team" as const,
        coordinatorId: "lead",
        prefix: "docs",
        workspaceRoot,
      };
      const proposal = await executeSystemAgentOperation(operation, runtime);
      expect(proposal).toMatchObject({
        applied: false,
        message: expect.stringContaining("team of 4: chief of staff, researcher, writer, reviewer"),
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expectAbsent(workspaceRoot);

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
      const entries = config.agents?.entries ?? {};
      const members = [
        ["docs-lead", "coordinator"],
        ["docs-researcher", "researcher"],
        ["docs-writer", "writer"],
        ["docs-reviewer", "reviewer"],
      ] as const;
      expect(Object.keys(entries)).toEqual(["ambient", ...members.map(([id]) => id)]);
      for (const [id, role] of members) {
        const workspace = path.join(workspaceRoot, id);
        const template = await loadAgentRole(role);
        expect(entries[id]).toMatchObject({ workspace, identity: template.identity });
        expect(readAgentProvenance(id)).toMatchObject({
          createdVia: "agent",
          creatorAgentId: "planner",
        });
        expect(await readText(workspace, "AGENTS.md")).toBe(template.files["AGENTS.md"]);
        await expectAbsent(path.join(workspace, "BOOTSTRAP.md"));
      }
      expect(entries["docs-lead"]?.subagents).toEqual({
        allowAgents: ["docs-researcher", "docs-writer", "docs-reviewer"],
        delegationMode: "prefer",
      });
      expect(config.agents?.defaults?.systemAgent?.agentId).toBe("docs-lead");
      const confirmation = lines.join("\n");
      expect(confirmation).toContain("docs-lead");
      expect(confirmation).toContain("Agents home");
      expect(confirmation).toContain("agent switcher");
    }));

  it.each(["unfinished-bootstrap", "authority-revoked", "post-commit-first"])(
    "reports and audits retained members after %s blocks the remaining team",
    (failure) =>
      withState(async ({ root, runtime, lines }) => {
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
          expect(await readText(workspace, "AGENTS.md")).toBe(
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
        await expectAbsent(path.join(workspaceRoot, "reviewer"));
      }),
  );
});
