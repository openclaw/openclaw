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
