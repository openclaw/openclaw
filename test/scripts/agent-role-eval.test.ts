import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_LIVE_AGENT_ROLE_EVAL_TIMEOUT_SECONDS,
  DEFAULT_LIVE_AGENT_ROLE_EVAL_REPORT_DIR,
  OLLAMA_CONTAINER_NAME,
  isOllamaModelRef,
  normalizeLiveAgentList,
  ollamaModelId,
  prepareOllamaForLiveWorkflow,
  resolveLiveWorkflowConfig,
  resolveRunLiveWorkflowConfig,
  runLiveWorkflowEvals,
  stopOllamaForLiveWorkflow,
  verifyLiveWorkflowReport,
} from "../../scripts/lib/agent-role-eval-workflow.mjs";
import {
  AGENT_ROLE_CONTRACTS,
  AGENT_ROLE_CONTRACT_BY_ID,
  AUTOMATION_PLAYBOOK_ARCHITECT_AGENT_ID,
  AUTOMATION_PLAYBOOK_ARCHITECT_DASHBOARD_METRICS,
  AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL,
  AUTOMATION_PLAYBOOK_ARCHITECT_EVIDENCE_LABELS,
  AUTOMATION_PLAYBOOK_ARCHITECT_EVALUATION_LOOP_STAGES,
  AUTOMATION_PLAYBOOK_ARCHITECT_FORBIDDEN_TOOLS,
  AUTOMATION_PLAYBOOK_ARCHITECT_HANDOFF_WORKFLOWS,
  AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_ROUTING_FIELDS,
  AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_ROUTING_RULES,
  AUTOMATION_PLAYBOOK_ARCHITECT_OPTIMIZATION_METRICS,
  AUTOMATION_PLAYBOOK_ARCHITECT_OPTIMIZATION_REQUIREMENTS,
  AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_STARTUP_DIRS,
  AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_STARTUP_FILES,
  AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_TOOLS,
  AUTOMATION_PLAYBOOK_ARCHITECT_REUSE_CATALOG_FIELDS,
  AUTOMATION_PLAYBOOK_ARCHITECT_REUSE_CATALOG_RULES,
  AUTOMATION_PLAYBOOK_ARCHITECT_SCHEDULED_EVAL_FIELDS,
  AUTOMATION_PLAYBOOK_ARCHITECT_SCHEDULED_EVAL_REQUIREMENTS,
  AUTOMATION_PLAYBOOK_ARCHITECT_TELEMETRY_EVENTS,
  AUTOMATION_PLAYBOOK_ARCHITECT_TELEMETRY_FIELDS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
  BROWSER_SESSION_CREDENTIAL_STEWARD_CANONICAL_STATE_FILES,
  BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_STATE_KEY_TERMS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE3_APPROVAL_GATES,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE3_HANDOFF_AGENTS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE3_HANDOFF_FIELDS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE4_TELEMETRY_EVENTS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE4_TELEMETRY_FIELDS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE5_DURABILITY_TERMS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE6_ROUTING_TERMS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_OUTPUT_SCHEMA_FIELDS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE2_REQUIRED_TERMS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_CANONICAL_FILES,
  BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_SAFETY_TERMS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_STATE_REQUIRED_FIELDS,
  BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS,
  MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
  MEMORY_KNOWLEDGE_CURATOR_FORBIDDEN_STATE_KEY_TERMS,
  MEMORY_KNOWLEDGE_CURATOR_FORBIDDEN_TOOLS,
  MEMORY_KNOWLEDGE_CURATOR_HANDOFF_AGENTS,
  MEMORY_KNOWLEDGE_CURATOR_HANDOFF_FIELDS,
  MEMORY_KNOWLEDGE_CURATOR_REQUIRED_CANONICAL_FILES,
  MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TERMS,
  MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TOOLS,
  MEMORY_KNOWLEDGE_CURATOR_SCHEMA_FIELDS,
  MEMORY_KNOWLEDGE_CURATOR_STATE_REQUIRED_FIELDS,
  MEMORY_KNOWLEDGE_CURATOR_TELEMETRY_EVENTS,
  MEMORY_KNOWLEDGE_CURATOR_TELEMETRY_FIELDS,
  DEFAULT_LIVE_AGENT_ROLE_EVAL_AGENTS,
  DEFAULT_SELF_CONTAINED_LIVE_PARAMS,
  DEFAULT_SELF_CONTAINED_LIVE_MODEL,
  DEFAULT_SELF_CONTAINED_OLLAMA_MIN_MEM_MB,
  createSelfContainedLiveEvalEnvironment,
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
  steps?: WorkflowStep[];
};

type SpawnCall = {
  command: string;
  args: readonly string[];
};

type SpawnResponse = {
  error?: Error;
  status?: number | null;
  stderr?: string;
  stdout?: string;
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

function writeAutomationPlaybookWorkspace(root: string) {
  const workspace = writeAgentWorkspace(
    root,
    AUTOMATION_PLAYBOOK_ARCHITECT_AGENT_ID,
    [
      "Automation & Playbook Architect drafts playbooks with approval gates, rollback, telemetry, handoff workflows, dashboards, and evaluation loops.",
      "Session Startup:",
      ...AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_STARTUP_FILES.map((file) => `- ${file}`),
      ...AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_STARTUP_DIRS.map((directory) => `- ${directory}`),
    ].join("\n"),
  );
  const standard = [
    "# Automation & Playbook Architect Operating Standard",
    ...AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_STARTUP_FILES,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_EVIDENCE_LABELS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_TELEMETRY_EVENTS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_TELEMETRY_FIELDS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_DASHBOARD_METRICS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_ROUTING_FIELDS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_ROUTING_RULES,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_REUSE_CATALOG_FIELDS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_REUSE_CATALOG_RULES,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_OPTIMIZATION_METRICS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_OPTIMIZATION_REQUIREMENTS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_SCHEDULED_EVAL_FIELDS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_SCHEDULED_EVAL_REQUIREMENTS,
    "title version last_updated status objective scope evidence_status assumptions unknowns preconditions trigger_conditions required_inputs dependencies owner reviewer related_agents handoffs step_by_step_procedure decision_branches stop_conditions error_handling human_approval_gates security_considerations rollback_plan validation_tests acceptance_criteria telemetry_events execution_boundary next_review",
    "credentials secrets tokens cookies contact/payment identifiers draft-only/no execution",
  ].join("\n");
  const contract = [
    "# Automation & Playbook Architect Operating Contract",
    ...AUTOMATION_PLAYBOOK_ARCHITECT_HANDOFF_WORKFLOWS,
    ...AUTOMATION_PLAYBOOK_ARCHITECT_EVALUATION_LOOP_STAGES,
    "Control Director Program Manager Judge Browser / Session / Credential Steward Memory & Knowledge Curator Telemetry & Evaluation Analyst",
    "trigger_condition input_sent output_expected owner approval_requirement failure_mode fix_for_failure_mode",
    "rollback_plan validation_tests acceptance_criteria human_approval_gates Rollback unavailable Judge review",
  ].join("\n");
  const files: Record<string, string> = {
    "docs/AUTOMATION_PLAYBOOK_ARCHITECT_STANDARD.md": `${standard}\n`,
    "docs/AUTOMATION_PLAYBOOK_ARCHITECT_OPERATING_CONTRACT.md": `${contract}\n`,
    "docs/AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_DECISION.md": `Default local drafting model: ${AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL}.\nDefault thinking: off.\n`,
    "memory/active-tasks.md": "No active execution tasks.\n",
    "memory/DECISIONS.md": "Unsafe execution remains denied by default.\n",
    "memory/LESSONS.md": "Telemetry and handoff workflows improve evaluation.\n",
    "state/VALIDATION_RESULTS.json": '{"status":"test"}\n',
    "logs/action-ledger.jsonl": "",
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  for (const directory of AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_STARTUP_DIRS) {
    fs.mkdirSync(path.join(workspace, directory), { recursive: true });
  }
  return workspace;
}

function writeBrowserSessionCredentialStewardWorkspace(root: string) {
  return writeAgentWorkspace(
    root,
    BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
    [
      "# Browser / Session / Credential Steward",
      "Scope: credential boundary, session hygiene, browser profile isolation, and cross-project contamination prevention.",
      "Safety: redact secrets, tokens, cookies, SSH keys, wallet data, and private-key material.",
      "Boundary: delegate execution and require approval before shell, browser profile mutation, login/session actions, credential handling, or file mutation.",
      "Execution boundary: draft-only/no execution unless approved by Control Director and the owning specialist.",
    ].join("\n"),
  );
}

function writeBrowserSessionCredentialStewardCanonicalFiles(root: string) {
  const docsDir = path.join(root, "control", "docs");
  const stateDir = path.join(root, "control", "state");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const schemaLines = BROWSER_SESSION_CREDENTIAL_STEWARD_OUTPUT_SCHEMA_FIELDS.join("\n");
  const requiredTerms = [
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE2_REQUIRED_TERMS,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE3_HANDOFF_AGENTS,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE3_HANDOFF_FIELDS,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE3_APPROVAL_GATES,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE4_TELEMETRY_EVENTS,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE4_TELEMETRY_FIELDS,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE5_DURABILITY_TERMS,
    ...BROWSER_SESSION_CREDENTIAL_STEWARD_PHASE6_ROUTING_TERMS,
  ].join("\n");
  fs.writeFileSync(
    path.join(docsDir, "BROWSER_SESSION_CREDENTIAL_STEWARD.md"),
    [
      "# Browser / Session / Credential Steward Contract",
      "Mission Scope Non-scope Required inputs Required outputs Structured output schema Credential handling rules Browser profile isolation rules Session hygiene rules SSH/wallet/private-key rules Approval gates Redaction rules Cross-project contamination rules Rollback/session cleanup rules Handoff workflows Approval matrix Telemetry events Durability checks Model routing scheduled regression",
      "Confirmed Inferred Assumption Risk Unknown Recommended verification step draft-only/no execution",
      schemaLines,
      requiredTerms,
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(docsDir, "BACKUP_SCOPE_BROWSER_SESSION_DENYLIST.md"),
    [
      "# Backup Scope Browser and Session Denylist",
      "browser cache browser cookies local storage session storage auth tokens wallet state SSH private keys credential vault exports profile lock files temporary download folders containing authenticated exports",
      "rollback_or_cleanup_plan evidence_status Unknown",
    ].join("\n"),
    "utf8",
  );
  const owner = "Browser / Session / Credential Steward";
  const writeJson = (relativePath: string, value: unknown) => {
    fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  writeJson("control/state/BROWSER_PROFILE_MAP.json", {
    schemaVersion: 1,
    lastUpdated: "UNKNOWN",
    owner,
    profiles: [],
    evidenceStatus: "Unknown",
    recommendedVerificationSteps: [],
  });
  writeJson("control/state/CREDENTIAL_BOUNDARY_MAP.json", {
    schemaVersion: 1,
    lastUpdated: "UNKNOWN",
    owner,
    credentialClasses: [],
    rules: [],
    evidenceStatus: "Unknown",
    recommendedVerificationSteps: [],
  });
  writeJson("control/state/SSH_ALIAS_MAP.json", {
    schemaVersion: 1,
    lastUpdated: "UNKNOWN",
    owner,
    aliases: [],
    evidenceStatus: "Unknown",
    recommendedVerificationSteps: [],
  });
  writeJson("control/state/SESSION_HYGIENE_STATUS.json", {
    schemaVersion: 1,
    lastUpdated: "UNKNOWN",
    owner,
    status: "UNKNOWN",
    checks: [],
    evidenceStatus: "Unknown",
    recommendedVerificationSteps: [],
  });
  writeJson("control/state/KEY_ROTATION_STATUS.json", {
    schemaVersion: 1,
    lastUpdated: "UNKNOWN",
    owner,
    status: "UNKNOWN",
    keys: [],
    evidenceStatus: "Unknown",
    recommendedVerificationSteps: [],
  });
  writeJson("control/state/LAST_KNOWN_GOOD_BROWSER_ISOLATION.json", {
    schemaVersion: 1,
    lastUpdated: "UNKNOWN",
    owner,
    validatedAt: "UNKNOWN",
    profiles: [],
    evidenceStatus: "Unknown",
    recommendedVerificationSteps: [],
  });
}

function writeMemoryKnowledgeCuratorWorkspace(root: string) {
  return writeAgentWorkspace(
    root,
    MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
    [
      "# Memory & Knowledge Curator",
      "Scope: memory provenance, confidence, freshness, privacy, private boundaries, and Unknown handling.",
      "Safety: redact raw private memory and secrets; require approval before risky promotion.",
      "Boundary: use source_class and evidence_status before durable memory promotion.",
    ].join("\n"),
  );
}

function writeMemoryKnowledgeCuratorCanonicalFiles(root: string) {
  const docsDir = path.join(root, "control", "docs");
  const stateDir = path.join(root, "control", "state");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const contract = [
    "# Memory & Knowledge Curator Contract",
    "approval gates redaction privacy boundary source/provenance/confidence/freshness contradiction/staleness cleanup prompt-injection handling hosted fallback explicit Control Director approval local-first routing",
    ...MEMORY_KNOWLEDGE_CURATOR_SCHEMA_FIELDS,
    ...MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TERMS,
    ...MEMORY_KNOWLEDGE_CURATOR_HANDOFF_AGENTS,
    ...MEMORY_KNOWLEDGE_CURATOR_HANDOFF_FIELDS,
    ...MEMORY_KNOWLEDGE_CURATOR_TELEMETRY_EVENTS,
    ...MEMORY_KNOWLEDGE_CURATOR_TELEMETRY_FIELDS,
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "MEMORY_KNOWLEDGE_CURATOR.md"), `${contract}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "MEMORY_KNOWLEDGE_CURATOR_STATUS.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        lastUpdated: "UNKNOWN",
        owner: "Memory & Knowledge Curator",
        status: "UNKNOWN",
        evidenceStatus: "Unknown",
        recommendedVerificationSteps: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeAgentDir(root: string, id: string) {
  const agentDir = path.join(root, "state", "agents", id, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function createWorkflowSpawn(responses: SpawnResponse[] = []) {
  const calls: SpawnCall[] = [];
  const queue = [...responses];
  const spawn = (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const response = queue.shift() ?? {};
    return {
      error: response.error,
      status: response.status ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? "",
    };
  };
  return { calls, spawn };
}

function baseConfig(root: string, agent: Record<string, unknown>) {
  return {
    models: {
      providers: {
        ollama: {
          models: [{ id: "qwen3.5:4b" }, { id: "qwen3.5:9b-q4_K_M" }, { id: "qwen3.5:27b-q8_0" }],
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

  it("keeps the CI live workflow aligned with local-first eval defaults", () => {
    const workflow = readAgentRoleEvalWorkflow();
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    const liveJob = workflow.jobs?.["live-role-turns"];
    const startOllama = requireWorkflowStep(liveJob, "Start local Ollama for local-first evals");
    const runLive = requireWorkflowStep(liveJob, "Run representative live role evals");
    const stopOllama = requireWorkflowStep(liveJob, "Stop local Ollama");
    const verifyReport = requireWorkflowStep(liveJob, "Verify live role eval report");
    const uploadReport = requireWorkflowStep(liveJob, "Upload live role eval report");
    const expectedAgentDefault = DEFAULT_LIVE_AGENT_ROLE_EVAL_AGENTS.join(",");

    expect(inputs?.live_model?.default).toBe(DEFAULT_SELF_CONTAINED_LIVE_MODEL);
    expect(inputs?.live_agents?.default).toBe(expectedAgentDefault);
    expect(inputs?.ollama_min_mem_mb?.default).toBe(
      String(DEFAULT_SELF_CONTAINED_OLLAMA_MIN_MEM_MB),
    );
    expect(startOllama.env?.INPUT_LIVE_MODEL).toBe("${{ inputs.live_model }}");
    expect(startOllama.env?.INPUT_OLLAMA_MIN_MEM_MB).toBe("${{ inputs.ollama_min_mem_mb }}");
    expect(startOllama.run).toBe("node scripts/agent-role-eval-workflow.mjs prepare-ollama");
    expect(runLive.env?.INPUT_LIVE_AGENTS).toBe("${{ inputs.live_agents }}");
    expect(runLive.env?.INPUT_TIMEOUT_SECONDS).toBe("${{ inputs.timeout_seconds }}");
    expect(runLive.env?.OPENCLAW_AGENT_ROLE_EVAL_REPORT_DIR).toBe(
      DEFAULT_LIVE_AGENT_ROLE_EVAL_REPORT_DIR,
    );
    expect(runLive.run).toBe("node scripts/agent-role-eval-workflow.mjs run-live");
    expect(stopOllama.run).toBe("node scripts/agent-role-eval-workflow.mjs stop-ollama");
    expect(verifyReport.env?.INPUT_LIVE_AGENTS).toBe("${{ inputs.live_agents }}");
    expect(verifyReport.env?.INPUT_TIMEOUT_SECONDS).toBe("${{ inputs.timeout_seconds }}");
    expect(verifyReport.run).toBe(
      `node scripts/agent-role-eval-workflow.mjs verify-report ${DEFAULT_LIVE_AGENT_ROLE_EVAL_REPORT_DIR}`,
    );
    expect(uploadReport.with?.name).toBe("agent-role-eval-report");
    expect(uploadReport.with?.path).toBe(DEFAULT_LIVE_AGENT_ROLE_EVAL_REPORT_DIR);
    expect(uploadReport.with?.["if-no-files-found"]).toBe("warn");
  });

  it("runs scheduled Memory Curator runtime guard regression coverage", () => {
    const workflow = readAgentRoleEvalWorkflow();
    const job = workflow.jobs?.["memory-curator-runtime-regression"];
    const staticContract = requireWorkflowStep(job, "Validate Memory Curator static contract");
    const runtimeGuard = requireWorkflowStep(job, "Run Memory Curator runtime guard tests");

    expect(job).toBeDefined();
    expect(staticContract.run).toBe(
      "node scripts/agent-role-eval.mjs --agent memory-knowledge-curator --json",
    );
    expect(runtimeGuard.run).toContain("extensions/memory-core/src/short-term-promotion.test.ts");
    expect(runtimeGuard.run).toContain("extensions/memory-core/src/cli.test.ts");
    expect(runtimeGuard.run).toContain("extensions/memory-core/src/dreaming.test.ts");
    expect(runtimeGuard.run).toContain("src/plugin-sdk/memory-host-events.test.ts");
    expect(runtimeGuard.run).toContain("src/gateway/server-methods/plugin-approval.test.ts");
    expect(runtimeGuard.run).toContain("src/agents/pi-tools.workspace-only-false.test.ts");
    expect(runtimeGuard.run).toContain("src/gateway/server-methods/doctor.test.ts");
    expect(runtimeGuard.run).toContain("ui/src/ui/controllers/dreaming.test.ts");
    expect(runtimeGuard.run).toContain("ui/src/ui/views/dreaming.test.ts");
    expect(runtimeGuard.run).toContain("test/scripts/agent-role-eval.test.ts");
  });

  it("resolves workflow live-eval inputs like GitHub Actions", () => {
    expect(normalizeLiveAgentList("main, judge program-manager main")).toEqual([
      "main",
      "judge",
      "program-manager",
    ]);
    expect(isOllamaModelRef(DEFAULT_SELF_CONTAINED_LIVE_MODEL)).toBe(true);
    expect(ollamaModelId(DEFAULT_SELF_CONTAINED_LIVE_MODEL)).toBe("qwen3.5:4b");

    expect(resolveLiveWorkflowConfig({})).toEqual({
      model: DEFAULT_SELF_CONTAINED_LIVE_MODEL,
      agents: DEFAULT_LIVE_AGENT_ROLE_EVAL_AGENTS,
      timeoutSeconds: DEFAULT_LIVE_AGENT_ROLE_EVAL_TIMEOUT_SECONDS,
      ollamaMinMemMb: DEFAULT_SELF_CONTAINED_OLLAMA_MIN_MEM_MB,
      bootstrapOllama: true,
    });

    expect(
      resolveRunLiveWorkflowConfig({
        INPUT_LIVE_AGENTS: "judge market-research-analyst",
        INPUT_TIMEOUT_SECONDS: "240",
        INPUT_OLLAMA_MIN_MEM_MB: "0",
        OPENCLAW_AGENT_EVAL_BOOTSTRAP_OLLAMA: "0",
        OPENCLAW_AGENT_ROLE_EVAL_RESOLVED_MODEL: "ollama/qwen3.5:9b-q4_K_M",
      }),
    ).toEqual({
      model: "ollama/qwen3.5:9b-q4_K_M",
      agents: ["judge", "market-research-analyst"],
      timeoutSeconds: 240,
      ollamaMinMemMb: 0,
      bootstrapOllama: false,
    });

    expect(OLLAMA_CONTAINER_NAME).toBe("openclaw-agent-role-eval-ollama");
  });

  it("plans the CI live eval commands from resolved workflow inputs", () => {
    const { calls, spawn } = createWorkflowSpawn();

    const status = runLiveWorkflowEvals({
      env: {
        INPUT_LIVE_AGENTS: "main,judge main",
        INPUT_TIMEOUT_SECONDS: "240",
        OPENCLAW_AGENT_ROLE_EVAL_RESOLVED_MODEL: "ollama/qwen3.5:9b-q4_K_M",
      },
      spawn: spawn as never,
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: "pnpm",
        args: [
          "agents:eval:live:self-contained",
          "--",
          "--agent",
          "main",
          "--timeout",
          "240",
          "--model",
          "ollama/qwen3.5:9b-q4_K_M",
        ],
      },
      {
        command: "pnpm",
        args: [
          "agents:eval:live:self-contained",
          "--",
          "--agent",
          "judge",
          "--timeout",
          "240",
          "--model",
          "ollama/qwen3.5:9b-q4_K_M",
        ],
      },
    ]);
  });

  it("stops CI live evals at the first failed agent", () => {
    const { calls, spawn } = createWorkflowSpawn([{ status: 0 }, { status: 1 }]);

    const status = runLiveWorkflowEvals({
      env: { INPUT_LIVE_AGENTS: "main judge program-manager" },
      spawn: spawn as never,
    });

    expect(status).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(["--agent", "judge", "--model", DEFAULT_SELF_CONTAINED_LIVE_MODEL]),
    );
  });

  it("writes durable live workflow report artifacts", () => {
    const root = harness.createTempDir("openclaw-agent-eval-report-");
    const reportDir = path.join(root, "reports");
    const stepSummary = path.join(root, "step-summary.md");
    const makeResult = (agentId: string, durationMs: number) =>
      JSON.stringify({
        ok: true,
        selfContained: true,
        results: [
          {
            ok: true,
            agentId,
            provider: "ollama",
            model: "qwen3.5:4b",
            durationMs,
            evaluation: { issues: [] },
          },
        ],
      });
    const { calls, spawn } = createWorkflowSpawn([
      { status: 0, stdout: `\n> openclaw@0 test\n${makeResult("main", 12)}\n` },
      { status: 0, stdout: makeResult("judge", 13) },
    ]);
    let stdout = "";

    const status = runLiveWorkflowEvals({
      env: {
        INPUT_LIVE_AGENTS: "main judge",
        OPENCLAW_AGENT_ROLE_EVAL_REPORT_DIR: reportDir,
        GITHUB_STEP_SUMMARY: stepSummary,
      },
      spawn: spawn as never,
      stdout: { write: (message: string) => ((stdout += message), true) } as never,
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("--json");
    expect(stdout).toContain("PASS main ollama/qwen3.5:4b 12ms");
    const summary = JSON.parse(readFileSync(path.join(reportDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      ok: true,
      model: DEFAULT_SELF_CONTAINED_LIVE_MODEL,
      agentsRequested: ["main", "judge"],
      results: [
        { ok: true, agentId: "main", provider: "ollama", model: "qwen3.5:4b" },
        { ok: true, agentId: "judge", provider: "ollama", model: "qwen3.5:4b" },
      ],
    });
    expect(summary.results[0]).not.toHaveProperty("error");
    expect(readFileSync(path.join(reportDir, "summary.md"), "utf8")).toContain(
      "Agent Role Live Eval Report",
    );
    expect(readFileSync(path.join(reportDir, "main.json"), "utf8")).toContain('"agentId": "main"');
    expect(readFileSync(path.join(reportDir, "main.stdout.log"), "utf8")).toContain(
      '"agentId":"main"',
    );
    expect(readFileSync(stepSummary, "utf8")).toContain("PASS judge ollama/qwen3.5:4b 13ms");
    expect(
      verifyLiveWorkflowReport({ reportDir, env: { INPUT_LIVE_AGENTS: "main judge" } }),
    ).toMatchObject({
      ok: true,
      reportDir,
      issueCount: 0,
      agentsRequested: ["main", "judge"],
      resultCount: 2,
      issues: [],
    });
  });

  it("rejects live workflow reports that do not match expected workflow inputs", () => {
    const root = harness.createTempDir("openclaw-agent-eval-report-");
    const reportDir = path.join(root, "reports");
    const { spawn } = createWorkflowSpawn([
      {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          selfContained: true,
          results: [
            {
              ok: true,
              agentId: "main",
              provider: "ollama",
              model: "qwen3.5:4b",
              durationMs: 12,
              evaluation: { issues: [] },
            },
          ],
        }),
      },
    ]);

    expect(
      runLiveWorkflowEvals({
        env: {
          INPUT_LIVE_AGENTS: "main",
          OPENCLAW_AGENT_ROLE_EVAL_REPORT_DIR: reportDir,
        },
        spawn: spawn as never,
        stdout: { write: () => true } as never,
      }),
    ).toBe(0);

    expect(
      verifyLiveWorkflowReport({
        reportDir,
        env: {
          INPUT_LIVE_AGENTS: "main judge",
          INPUT_TIMEOUT_SECONDS: "240",
          OPENCLAW_AGENT_ROLE_EVAL_RESOLVED_MODEL: "ollama/qwen3.5:9b-q4_K_M",
        },
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        'summary.json model "ollama/qwen3.5:4b" does not match expected "ollama/qwen3.5:9b-q4_K_M".',
        "summary.json timeoutSeconds 180 does not match expected 240.",
        'summary.json agentsRequested ["main"] does not match expected ["main","judge"].',
      ]),
    });
  });

  it("fails live workflow report mode when the evaluator rejects a response", () => {
    const root = harness.createTempDir("openclaw-agent-eval-report-");
    const reportDir = path.join(root, "reports");
    const { calls, spawn } = createWorkflowSpawn([
      {
        status: 0,
        stdout: JSON.stringify({
          ok: false,
          selfContained: true,
          results: [
            {
              ok: false,
              agentId: "main",
              evaluation: { issues: ["missing role signal coverage"] },
            },
          ],
        }),
      },
    ]);

    const status = runLiveWorkflowEvals({
      env: {
        INPUT_LIVE_AGENTS: "main judge",
        OPENCLAW_AGENT_ROLE_EVAL_REPORT_DIR: reportDir,
      },
      spawn: spawn as never,
      stdout: { write: () => true } as never,
    });

    expect(status).toBe(1);
    expect(calls).toHaveLength(1);
    const summary = JSON.parse(readFileSync(path.join(reportDir, "summary.json"), "utf8"));
    expect(summary.ok).toBe(false);
    expect(summary.results[0]).toMatchObject({
      ok: false,
      agentId: "main",
      issues: ["missing role signal coverage"],
    });
    expect(
      verifyLiveWorkflowReport({ reportDir, env: { INPUT_LIVE_AGENTS: "main judge" } }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "summary.json reports a failed live eval.",
        "main result is not passing.",
      ]),
    });
  });

  it("rejects incomplete live workflow report artifacts", () => {
    const root = harness.createTempDir("openclaw-agent-eval-report-");
    const reportDir = path.join(root, "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, "summary.json"),
      `${JSON.stringify({
        ok: true,
        model: DEFAULT_SELF_CONTAINED_LIVE_MODEL,
        timeoutSeconds: 180,
        startedAt: "2026-05-18T00:00:00.000Z",
        completedAt: "2026-05-18T00:00:01.000Z",
        agentsRequested: ["main", "judge"],
        results: [
          {
            ok: true,
            agentId: "main",
            status: 0,
            provider: "ollama",
            model: "qwen3.5:4b",
            issues: [],
          },
        ],
      })}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(reportDir, "summary.md"), "# Agent Role Live Eval Report\n", "utf8");

    const result = verifyLiveWorkflowReport({
      reportDir,
      env: { INPUT_LIVE_AGENTS: "main judge" },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "summary.json result count 1 does not match requested count 2.",
        "summary.json is missing result for judge.",
        expect.stringContaining("main.json is missing or invalid JSON: ENOENT"),
        "main.stdout.log is missing.",
        "main.stderr.log is missing.",
      ]),
    );
  });

  it("skips local Ollama bootstrap for non-Ollama live models", () => {
    let stdout = "";
    const { calls, spawn } = createWorkflowSpawn();

    const status = prepareOllamaForLiveWorkflow({
      env: { INPUT_LIVE_MODEL: "openai/gpt-5.5" },
      spawn: spawn as never,
      stdout: { write: (message: string) => ((stdout += message), true) } as never,
    });

    expect(status).toBe(0);
    expect(calls).toEqual([]);
    expect(stdout).toContain("skipping local Ollama bootstrap");
  });

  it("skips local Ollama bootstrap when the workflow is configured for external Ollama", () => {
    let stdout = "";
    const { calls, spawn } = createWorkflowSpawn();

    const status = prepareOllamaForLiveWorkflow({
      env: { OPENCLAW_AGENT_EVAL_BOOTSTRAP_OLLAMA: "0" },
      spawn: spawn as never,
      stdout: { write: (message: string) => ((stdout += message), true) } as never,
    });

    expect(status).toBe(0);
    expect(calls).toEqual([]);
    expect(stdout).toContain("expecting an external Ollama endpoint");
  });

  it("plans local Ollama startup, memory proof, model pull, and GitHub env handoff", () => {
    const root = harness.createTempDir("openclaw-agent-eval-workflow-");
    const githubEnv = path.join(root, "github-env");
    const { calls, spawn } = createWorkflowSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: `${DEFAULT_SELF_CONTAINED_OLLAMA_MIN_MEM_MB * 1024}\n` },
      { status: 0 },
    ]);

    const status = prepareOllamaForLiveWorkflow({
      env: { GITHUB_ENV: githubEnv },
      spawn: spawn as never,
    });

    expect(status).toBe(0);
    expect(readFileSync(githubEnv, "utf8")).toBe(
      `OPENCLAW_AGENT_ROLE_EVAL_RESOLVED_MODEL=${DEFAULT_SELF_CONTAINED_LIVE_MODEL}\n`,
    );
    expect(calls).toEqual([
      { command: "docker", args: ["rm", "-f", OLLAMA_CONTAINER_NAME] },
      {
        command: "docker",
        args: expect.arrayContaining([
          "run",
          "--pull=always",
          "-d",
          "--name",
          OLLAMA_CONTAINER_NAME,
          "-e",
          "OLLAMA_CONTEXT_LENGTH=1024",
          "-e",
          "OLLAMA_NUM_PARALLEL=1",
          "-p",
          "127.0.0.1:11434:11434",
          "ollama/ollama:latest",
        ]),
      },
      { command: "curl", args: ["-fsS", "http://127.0.0.1:11434/api/version"] },
      {
        command: "docker",
        args: ["exec", OLLAMA_CONTAINER_NAME, "awk", "/MemAvailable:/ {print $2}", "/proc/meminfo"],
      },
      {
        command: "docker",
        args: ["exec", OLLAMA_CONTAINER_NAME, "ollama", "pull", "qwen3.5:4b"],
      },
    ]);
  });

  it("blocks local Ollama startup when runner memory is below the verified floor", () => {
    let stdout = "";
    const { calls, spawn } = createWorkflowSpawn([
      { status: 0 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "1024\n" },
      { status: 0 },
    ]);

    const status = prepareOllamaForLiveWorkflow({
      spawn: spawn as never,
      stdout: { write: (message: string) => ((stdout += message), true) } as never,
    });

    expect(status).toBe(1);
    expect(stdout).toContain("::error title=Ollama runner memory too low");
    expect(calls.map((call) => call.command)).toEqual([
      "docker",
      "docker",
      "curl",
      "docker",
      "docker",
    ]);
    expect(calls.at(-1)?.args).toEqual(["stats", "--no-stream", OLLAMA_CONTAINER_NAME]);
  });

  it("always attempts Ollama cleanup without failing the workflow", () => {
    const { calls, spawn } = createWorkflowSpawn([{ status: 1 }]);

    expect(stopOllamaForLiveWorkflow({ spawn: spawn as never })).toBe(0);
    expect(calls).toEqual([{ command: "docker", args: ["rm", "-f", OLLAMA_CONTAINER_NAME] }]);
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

  it("filters static checks to one requested configured agent", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    const agentDir = writeAgentDir(root, id);
    const config = baseConfig(root, {
      id,
      name: "Program Manager",
      workspace,
      agentDir,
      model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
    });
    config.agents.list.push({
      id: "new-agent-without-contract",
      name: "New Agent Without Contract",
      workspace: writeAgentWorkspace(root, "new-agent-without-contract", "unknown"),
      agentDir: writeAgentDir(root, "new-agent-without-contract"),
    });

    const result = evaluateAgentStaticContracts(config, {
      agentId: id,
      stateDir: path.join(root, "state"),
    });

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

  it("accepts the hardened Automation & Playbook Architect Phase 4 static config", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeAutomationPlaybookWorkspace(root);
    const agentDir = writeAgentDir(root, AUTOMATION_PLAYBOOK_ARCHITECT_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: AUTOMATION_PLAYBOOK_ARCHITECT_AGENT_ID,
        name: "Automation & Playbook Architect",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        thinkingDefault: "off",
        tools: {
          profile: "minimal",
          alsoAllow: [...AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_TOOLS],
          deny: [...AUTOMATION_PLAYBOOK_ARCHITECT_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("rejects missing Automation & Playbook Architect Phase 4 docs", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeAutomationPlaybookWorkspace(root);
    fs.writeFileSync(
      path.join(workspace, "docs/AUTOMATION_PLAYBOOK_ARCHITECT_STANDARD.md"),
      "# Incomplete\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspace, "docs/AUTOMATION_PLAYBOOK_ARCHITECT_OPERATING_CONTRACT.md"),
      "# Incomplete\n",
      "utf8",
    );
    const agentDir = writeAgentDir(root, AUTOMATION_PLAYBOOK_ARCHITECT_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: AUTOMATION_PLAYBOOK_ARCHITECT_AGENT_ID,
        name: "Automation & Playbook Architect",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        thinkingDefault: "off",
        tools: {
          profile: "minimal",
          alsoAllow: [...AUTOMATION_PLAYBOOK_ARCHITECT_REQUIRED_TOOLS],
          deny: [...AUTOMATION_PLAYBOOK_ARCHITECT_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state") },
    );
    const codes = result.issues.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "automation_playbook_telemetry_event_missing",
        "automation_playbook_telemetry_field_missing",
        "automation_playbook_handoff_workflow_missing",
        "automation_playbook_dashboard_metric_missing",
        "automation_playbook_evaluation_loop_stage_missing",
        "automation_playbook_model_routing_field_missing",
        "automation_playbook_reuse_catalog_field_missing",
        "automation_playbook_optimization_metric_missing",
        "automation_playbook_scheduled_eval_field_missing",
      ]),
    );
  });

  it("keeps Automation & Playbook Architect Phase 4 constants complete", () => {
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_TELEMETRY_EVENTS).toEqual(
      expect.arrayContaining([
        "automation_playbook.created",
        "automation_playbook.handoff_completed",
        "automation_playbook.evaluation_loop_completed",
      ]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_TELEMETRY_FIELDS).toEqual(
      expect.arrayContaining(["event_name", "playbook_id", "correlation_id", "timestamp"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_HANDOFF_WORKFLOWS).toEqual(
      expect.arrayContaining(["Program Manager tracking workflow", "Judge review workflow"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_DASHBOARD_METRICS).toEqual(
      expect.arrayContaining(["playbook_reuse_rate", "automation_failure_rate", "judge_pass_rate"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_ROUTING_FIELDS).toEqual(
      expect.arrayContaining(["task_type", "risk_level", "fallback_model"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_MODEL_ROUTING_RULES).toEqual(
      expect.arrayContaining([
        "Control Director to a stronger supported model",
        "hosted/external models require approval before external data transfer",
      ]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_REUSE_CATALOG_FIELDS).toEqual(
      expect.arrayContaining(["playbook_id", "reuse_count", "deprecation_reason"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_REUSE_CATALOG_RULES).toEqual(
      expect.arrayContaining(["search catalog before drafting", "archive unsafe/outdated entries"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_OPTIMIZATION_METRICS).toEqual(
      expect.arrayContaining(["time_to_first_draft", "catalog_hit_rate", "judge_rework_rate"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_OPTIMIZATION_REQUIREMENTS).toEqual(
      expect.arrayContaining(["no duplicate handoffs", "no external live eval without approval"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_SCHEDULED_EVAL_FIELDS).toEqual(
      expect.arrayContaining(["eval name", "artifact path", "cleanup rule"]),
    );
    expect(AUTOMATION_PLAYBOOK_ARCHITECT_SCHEDULED_EVAL_REQUIREMENTS).toEqual(
      expect.arrayContaining(["static checks run frequently", "local-model pinned"]),
    );
  });

  it("accepts the hardened Browser / Session / Credential Steward Phase 1 static config", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("rejects unsafe Browser / Session / Credential Steward exec defaults", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "full", ask: "off" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );
    const codes = result.issues.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "browser_steward_exec_policy_unsafe",
        "browser_steward_exec_approval_missing",
      ]),
    );
  });

  it("rejects Browser / Session / Credential Steward browser and web authority by default", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS, "browser", "group:web"],
          deny: BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS.filter(
            (tool) => tool !== "browser" && tool !== "group:web",
          ),
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
          code: "browser_steward_unsafe_tool_callable",
          tool: "browser",
        }),
        expect.objectContaining({
          agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
          code: "browser_steward_unsafe_tool_callable",
          tool: "group:web",
        }),
      ]),
    );
  });

  it("rejects Browser / Session / Credential Steward missing canonical Phase 2 docs", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    fs.unlinkSync(path.join(root, "control/docs/BROWSER_SESSION_CREDENTIAL_STEWARD.md"));
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_canonical_file_missing",
        file: "control/docs/BROWSER_SESSION_CREDENTIAL_STEWARD.md",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward missing Phase 2 schema field", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const contractPath = path.join(root, "control/docs/BROWSER_SESSION_CREDENTIAL_STEWARD.md");
    fs.writeFileSync(
      contractPath,
      readFileSync(contractPath, "utf8").replaceAll("boundary_decision", "boundary verdict"),
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_output_schema_field_missing",
        field: "boundary_decision",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward missing Phase 3 handoff", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const contractPath = path.join(root, "control/docs/BROWSER_SESSION_CREDENTIAL_STEWARD.md");
    fs.writeFileSync(
      contractPath,
      readFileSync(contractPath, "utf8").replaceAll("Control Director", "Control Lead"),
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_phase3_handoff_missing",
        handoff: "Control Director",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward missing Phase 3 approval gate", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const contractPath = path.join(root, "control/docs/BROWSER_SESSION_CREDENTIAL_STEWARD.md");
    fs.writeFileSync(
      contractPath,
      readFileSync(contractPath, "utf8").replaceAll(
        "browser/profile mutation",
        "browser profile change",
      ),
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_phase3_approval_gate_missing",
        gate: "browser/profile mutation",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward missing Phase 4 telemetry event", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    const contractPath = path.join(root, "control/docs/BROWSER_SESSION_CREDENTIAL_STEWARD.md");
    fs.writeFileSync(
      contractPath,
      readFileSync(contractPath, "utf8").replaceAll(
        "browser_steward.boundary_decision",
        "browser_steward.boundary_outcome",
      ),
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_phase4_telemetry_event_missing",
        event: "browser_steward.boundary_decision",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward invalid canonical JSON state", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    fs.writeFileSync(
      path.join(root, "control/state/SESSION_HYGIENE_STATUS.json"),
      "{bad json",
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_canonical_json_invalid",
        file: "control/state/SESSION_HYGIENE_STATUS.json",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward state missing required durability field", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    fs.writeFileSync(
      path.join(root, "control/state/BROWSER_PROFILE_MAP.json"),
      `${JSON.stringify({ schemaVersion: 1, lastUpdated: "UNKNOWN", owner: "Browser / Session / Credential Steward", profiles: [], recommendedVerificationSteps: [] }, null, 2)}\n`,
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_state_required_field_missing",
        file: "control/state/BROWSER_PROFILE_MAP.json",
        field: "evidenceStatus",
      }),
    );
  });

  it("rejects Browser / Session / Credential Steward secret-like keys in canonical JSON state", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeBrowserSessionCredentialStewardWorkspace(root);
    writeBrowserSessionCredentialStewardCanonicalFiles(root);
    fs.writeFileSync(
      path.join(root, "control/state/CREDENTIAL_BOUNDARY_MAP.json"),
      `${JSON.stringify({ schemaVersion: 1, lastUpdated: "UNKNOWN", owner: "Browser / Session / Credential Steward", apiKey: "UNKNOWN" }, null, 2)}\n`,
      "utf8",
    );
    const agentDir = writeAgentDir(root, BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        name: "Browser / Session / Credential Steward",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS],
          deny: [...BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: BROWSER_SESSION_CREDENTIAL_STEWARD_AGENT_ID,
        code: "browser_steward_state_secret_key_forbidden",
        file: "control/state/CREDENTIAL_BOUNDARY_MAP.json",
        keyPath: "apiKey",
      }),
    );
  });

  it("keeps Browser / Session / Credential Steward Phase 1 constants complete", () => {
    expect(BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_TOOLS).toEqual(
      expect.arrayContaining(["read", "memory_search", "sessions_send", "session_status"]),
    );
    expect(BROWSER_SESSION_CREDENTIAL_STEWARD_FORBIDDEN_TOOLS).toEqual(
      expect.arrayContaining(["exec", "write", "cron", "browser", "group:web"]),
    );
    expect(BROWSER_SESSION_CREDENTIAL_STEWARD_REQUIRED_SAFETY_TERMS).toEqual(
      expect.arrayContaining([
        "credential",
        "browser profile",
        "approval",
        "redact",
        "delegate",
        "cross-project contamination",
        "draft-only/no execution",
      ]),
    );
    expect(
      AGENT_ROLE_CONTRACT_BY_ID.has("browser-session-credential-steward-safety-boundary"),
    ).toBe(true);
  });

  it("accepts the hardened Memory & Knowledge Curator static config", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeMemoryKnowledgeCuratorWorkspace(root);
    writeMemoryKnowledgeCuratorCanonicalFiles(root);
    const agentDir = writeAgentDir(root, MEMORY_KNOWLEDGE_CURATOR_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
        name: "Memory & Knowledge Curator",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        thinkingDefault: "off",
        tools: {
          profile: "minimal",
          alsoAllow: [...MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TOOLS],
          deny: [...MEMORY_KNOWLEDGE_CURATOR_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("rejects unsafe Memory & Knowledge Curator exec defaults", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeMemoryKnowledgeCuratorWorkspace(root);
    writeMemoryKnowledgeCuratorCanonicalFiles(root);
    const agentDir = writeAgentDir(root, MEMORY_KNOWLEDGE_CURATOR_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
        name: "Memory & Knowledge Curator",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TOOLS],
          deny: [...MEMORY_KNOWLEDGE_CURATOR_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "full", ask: "off" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "memory_curator_exec_policy_unsafe" }),
        expect.objectContaining({ code: "memory_curator_exec_approval_missing" }),
      ]),
    );
  });

  it("rejects Memory & Knowledge Curator missing schema field", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeMemoryKnowledgeCuratorWorkspace(root);
    writeMemoryKnowledgeCuratorCanonicalFiles(root);
    const contractPath = path.join(root, "control/docs/MEMORY_KNOWLEDGE_CURATOR.md");
    fs.writeFileSync(
      contractPath,
      readFileSync(contractPath, "utf8").replaceAll("memory_decision", "memory verdict"),
      "utf8",
    );
    const agentDir = writeAgentDir(root, MEMORY_KNOWLEDGE_CURATOR_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
        name: "Memory & Knowledge Curator",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TOOLS],
          deny: [...MEMORY_KNOWLEDGE_CURATOR_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
        code: "memory_curator_schema_field_missing",
        field: "memory_decision",
      }),
    );
  });

  it("rejects Memory & Knowledge Curator secret-like state keys", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const workspace = writeMemoryKnowledgeCuratorWorkspace(root);
    writeMemoryKnowledgeCuratorCanonicalFiles(root);
    fs.writeFileSync(
      path.join(root, "control/state/MEMORY_KNOWLEDGE_CURATOR_STATUS.json"),
      `${JSON.stringify({ schemaVersion: 1, lastUpdated: "UNKNOWN", owner: "Memory & Knowledge Curator", status: "UNKNOWN", evidenceStatus: "Unknown", recommendedVerificationSteps: [], apiKey: "UNKNOWN" }, null, 2)}\n`,
      "utf8",
    );
    const agentDir = writeAgentDir(root, MEMORY_KNOWLEDGE_CURATOR_AGENT_ID);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id: MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
        name: "Memory & Knowledge Curator",
        workspace,
        agentDir,
        model: { primary: AUTOMATION_PLAYBOOK_ARCHITECT_DEFAULT_MODEL, fallbacks: [] },
        tools: {
          profile: "minimal",
          alsoAllow: [...MEMORY_KNOWLEDGE_CURATOR_REQUIRED_TOOLS],
          deny: [...MEMORY_KNOWLEDGE_CURATOR_FORBIDDEN_TOOLS],
          exec: { host: "auto", security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
        },
      }),
      { stateDir: path.join(root, "state"), repoRoot: root },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agentId: MEMORY_KNOWLEDGE_CURATOR_AGENT_ID,
        code: "memory_curator_state_secret_key_forbidden",
      }),
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
