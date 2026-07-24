import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AGENT_ROLE_CONTRACTS,
  AGENT_ROLE_CONTRACT_BY_ID,
  DEFAULT_SELF_CONTAINED_LIVE_PARAMS,
  DEFAULT_SELF_CONTAINED_LIVE_MODEL,
  createSelfContainedLiveEvalEnvironment,
  defaultConfigPath,
  evaluateAgentLiveText,
  evaluateAgentRoleContractCatalog,
  evaluateAgentStaticContracts,
} from "../../scripts/lib/agent-role-evals.mjs";
import { createScriptTestHarness } from "./test-helpers.ts";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  if?: string;
  steps?: WorkflowStep[];
};

type AgentRoleEvalWorkflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string | boolean }>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
};

function readAgentRoleEvalWorkflow(): AgentRoleEvalWorkflow {
  return parse(
    readFileSync(".github/workflows/agent-role-evals.yml", "utf8"),
  ) as AgentRoleEvalWorkflow;
}

function requireWorkflowStep(job: WorkflowJob | undefined, name: string): WorkflowStep {
  const step = job?.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Expected Agent Role Evals workflow step: ${name}`);
  }
  return step;
}

function writeAgentWorkspace(root: string, id: string, body: string) {
  const workspace = path.join(root, `workspace-${id}`);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), body);
  fs.writeFileSync(path.join(workspace, "IDENTITY.md"), body);
  return workspace;
}

function writeAgentDir(root: string, id: string) {
  const agentDir = path.join(root, "state", "agents", id, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function baseConfig(root: string, agent: Record<string, unknown>) {
  return {
    models: {
      providers: {
        ollama: {
          models: [{ id: "qwen3.5:4b" }, { id: "qwen3.5:9b-q4_K_M" }],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
        workspace: path.join(root, "workspace"),
      },
      list: [agent],
    },
  };
}

describe("agent role eval harness", () => {
  const harness = createScriptTestHarness();

  it("keeps role contracts unique and covers critical agents", () => {
    const ids = AGENT_ROLE_CONTRACTS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("main")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("judge")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("memory-knowledge-curator")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("openbrain-local-smoke")).toBe(true);
  });

  it("passes the deterministic checked-in contract catalog gate", () => {
    const result = evaluateAgentRoleContractCatalog();

    expect(result).toMatchObject({
      ok: true,
      contractCount: AGENT_ROLE_CONTRACTS.length,
      criticalContractCount: 8,
      issues: [],
    });
  });

  it("prompts live evals to emit exact role signals", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("program-manager")!;

    expect(contract.prompt).toContain("Use at least two exact role signal terms");
    expect(contract.prompt).toContain("Put one exact role signal in ROLE");
    expect(contract.prompt).toContain("do not use slash commands as content");
    expect(contract.prompt).toContain("BLOCKED: <reason>");
    expect(contract.prompt).toContain("Stop immediately after the BLOCK_OR_ESCALATE line");
    expect(contract.prompt).toContain("milestone, owner, acceptance, status, dependency");
  });

  it("creates a self-contained live eval state that passes static checks", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("judge")!;
    const fixture = createSelfContainedLiveEvalEnvironment([contract], {
      modelRef: DEFAULT_SELF_CONTAINED_LIVE_MODEL,
      keep: true,
    });
    harness.trackTempDir(fixture.root);

    expect(fs.existsSync(fixture.configPath)).toBe(true);
    expect(fixture.env.OPENCLAW_CONFIG_PATH).toBe(fixture.configPath);
    expect(fixture.env.OPENCLAW_STATE_DIR).toBe(fixture.stateDir);
    expect(fixture.config.agents.list[0]?.params).toEqual(DEFAULT_SELF_CONTAINED_LIVE_PARAMS);

    const result = evaluateAgentStaticContracts(fixture.config, {
      stateDir: fixture.stateDir,
    });
    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("keeps the CI workflow deterministic and secret-free", () => {
    const source = readFileSync(".github/workflows/agent-role-evals.yml", "utf8");
    const workflow = readAgentRoleEvalWorkflow();
    const contractJob = workflow.jobs?.["contract-catalog"];

    expect(workflow.on?.workflow_dispatch).toEqual(null);
    expect(workflow.jobs?.["live-role-turns"]).toBeUndefined();
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("OPENCLAW_AGENT_ROLE_EVAL_LIVE");
    expect(source).not.toContain("ci-hydrate-live-auth");
    expect(source).not.toContain("actions/upload-artifact");
    expect(requireWorkflowStep(contractJob, "Validate role contracts").run).toBe(
      "pnpm agents:eval:contracts",
    );
  });

  it("defaults agent eval config lookup to the canonical OpenClaw config path", () => {
    expect(defaultConfigPath("/tmp/home", {})).toBe("/tmp/home/.openclaw/openclaw.json");
    expect(defaultConfigPath("/tmp/home", { OPENCLAW_STATE_DIR: "/tmp/state" })).toBe(
      "/tmp/state/openclaw.json",
    );
    expect(
      defaultConfigPath("/tmp/home", {
        OPENCLAW_CONFIG_PATH: "/tmp/custom/openclaw.json",
        OPENCLAW_STATE_DIR: "/tmp/state",
      }),
    ).toBe("/tmp/custom/openclaw.json");
  });

  it("passes a configured agent with docs, runtime dir, model, and callable tools", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "Program Manager",
        workspace,
        agentDir,
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("uses canonical OpenClaw state dir for omitted agentDir", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const homeDir = path.join(root, "home");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    fs.mkdirSync(path.join(homeDir, ".openclaw", "agents", id, "agent"), { recursive: true });

    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "Program Manager",
        workspace,
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
      }),
      { homeDir },
    );

    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ agentId: id, code: "agent_dir_missing" }),
    );
    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("fails unknown agents so every configured role needs an eval contract", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "new-agent-without-contract";
    const workspace = writeAgentWorkspace(root, id, "New Agent Without Contract");
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "New Agent Without Contract",
        workspace,
        agentDir,
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ agentId: id, code: "contract_missing" }),
    );
  });

  it("fails unconfigured primary model references", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "Program Manager",
        workspace,
        agentDir,
        model: { primary: "ollama/not-configured", fallbacks: [] },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ agentId: id, code: "primary_model_unconfigured" }),
    );
  });

  it("detects tool policies that remove every callable tool", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "openbrain-local-smoke";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "OpenBrain Local Smoke verifies local model session smoke.",
    );
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "OpenBrain Local Smoke",
        workspace,
        agentDir,
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
        tools: { profile: "minimal", deny: ["session_status"] },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ agentId: id, code: "tool_policy_empty" }),
    );
  });

  it("scores live response text against role and truthfulness signals", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("judge")!;

    expect(
      evaluateAgentLiveText(
        contract,
        [
          "ROLE: verdict evidence",
          "EVIDENCE: evidence was reviewed",
          "RISK: risk remains until the claim is verified",
          "NEXT_ACTION: approve or reject after review",
          "BLOCK_OR_ESCALATE: CLEAR",
        ].join("\n"),
      ).ok,
    ).toBe(true);
    expect(evaluateAgentLiveText(contract, "I do not know my role.").ok).toBe(false);
  });

  it("rejects live responses with slash-command label content", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("program-manager")!;
    const result = evaluateAgentLiveText(
      contract,
      [
        "ROLE: milestone owner",
        "EVIDENCE: evidence is pending",
        "RISK: risk remains",
        "NEXT_ACTION: acceptance status",
        "BLOCK_OR_ESCALATE: /no_think",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("slash command content is not allowed in BLOCK_OR_ESCALATE:");
  });

  it("rejects duplicated live response labels", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("program-manager")!;
    const result = evaluateAgentLiveText(
      contract,
      [
        "ROLE: milestone owner",
        "EVIDENCE: evidence is pending",
        "RISK: risk remains",
        "NEXT_ACTION: acceptance status",
        "BLOCK_OR_ESCALATE: CLEAR",
        "ROLE: dependency owner",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("live response must be exactly 5 non-empty lines");
    expect(result.issues).toContain("duplicate live response label: ROLE:");
  });
});
