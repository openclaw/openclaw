import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import type { PipelineSpecZ } from "./pipeline.spec.js";

export type PipelineRunOptions = {
  phase?: string;
  until?: string;
  yes?: boolean;
  dryRun?: boolean;
};

type StepRunRecord = {
  id: string;
  phase: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  runId?: string;
  status?: string;
  error?: string;
  meta?: Record<string, unknown>;
};

// (intentionally no LoopFixPlan type; agent writes fixplan files directly)

function now() {
  return Date.now();
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveWorkspaceRoot() {
  const cfg = loadConfig();
  const ws = cfg.agents?.defaults?.workspace;
  if (!ws) {
    throw new Error("agents.defaults.workspace is not set in config");
  }
  return ws;
}

function absPath(workspaceRoot: string, p: string) {
  if (path.isAbsolute(p)) {
    return p;
  }
  return path.join(workspaceRoot, p);
}

function filesExist(workspaceRoot: string, files: string[]) {
  return files.every((f) => fs.existsSync(absPath(workspaceRoot, f)));
}

async function runAgentTurn(params: {
  agentId?: string;
  sessionKey: string;
  message: string;
  timeoutMs: number;
}) {
  const idempotencyKey = crypto.randomUUID();
  const resp = await callGateway<{ runId?: string }>({
    method: "agent",
    params: {
      message: params.message,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      deliver: false,
      // channel omitted; gateway will infer/default

      lane: "pipeline",
      timeout: 0,
      idempotencyKey,
    },
    timeoutMs: 10_000,
  });
  const runId = typeof resp?.runId === "string" && resp.runId ? resp.runId : idempotencyKey;

  const waitMs = params.timeoutMs;
  const wait = await callGateway<{ status?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs: waitMs },
    timeoutMs: waitMs + 2_000,
  });
  return { runId, status: wait?.status ?? "unknown" };
}

function readVerdictFromFile(workspaceRoot: string, filePath: string): string {
  const abs = absPath(workspaceRoot, filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Verdict file does not exist: ${filePath} (resolved ${abs})`);
  }
  return fs.readFileSync(abs, "utf8");
}

function parseVerdict(text: string): "PASS" | "WARN" | "FAIL" | "ABORT" | "UNKNOWN" {
  const upper = text.toUpperCase();
  if (upper.includes("ABORT")) {
    return "ABORT";
  }
  // Prefer FAIL over WARN if both appear.
  if (upper.includes("FAIL")) {
    return "FAIL";
  }
  if (upper.includes("WARN")) {
    return "WARN";
  }
  if (upper.includes("PASS")) {
    return "PASS";
  }
  return "UNKNOWN";
}

// NOTE: previously the runner wrote fixplan files itself. We now have the agent write them directly.

export async function runPipeline(spec: PipelineSpecZ, opts: PipelineRunOptions) {
  const workspaceRoot = resolveWorkspaceRoot();

  // Default to running on the agent's own sessionKey (pipeline runner is CLI-side).
  // For now we use a stable internal session key derived from agentId.
  // TODO: support explicit sessionKey in spec.
  const sessionKey = `agent:${spec.agentId ?? "flash-orchestrator"}:pipeline`;

  // Capability preflight: prove the agent can write to runDir.
  const preflightRel = path.join(spec.runDir, ".pipeline-preflight.txt");
  const preflightAbs = absPath(workspaceRoot, preflightRel);
  if (!opts.dryRun) {
    const preflightPrompt =
      `Preflight check: you must write a file to prove you can write artifacts.\n\n` +
      `Write EXACTLY this text into the following file (overwrite if exists):\n` +
      `${preflightAbs}\n\n` +
      `Text to write:\n` +
      `PIPELINE_PREFLIGHT_OK\n\n` +
      `After writing, reply with ONLY: OK`;

    await runAgentTurn({
      agentId: spec.agentId,
      sessionKey,
      message: preflightPrompt,
      timeoutMs: 2 * 60 * 1000,
    });

    const startWait = now();
    while (!fs.existsSync(preflightAbs)) {
      if (now() - startWait > 2 * 60 * 1000) {
        throw new Error(
          `Pipeline preflight failed: agent did not create ${preflightRel}. Ensure the agent can write files to the workspace.`,
        );
      }
      sleep(200);
    }
  }

  const steps = spec.steps;
  const stepById = new Map(steps.map((s) => [s.id, s] as const));

  const records: StepRunRecord[] = [];
  const completed = new Set<string>();

  const loops = spec.loops ?? [];
  const loopsByVerdictStepId = new Map<string, (typeof loops)[number][]>();
  for (const l of loops) {
    const arr = loopsByVerdictStepId.get(l.verdictStepId) ?? [];
    arr.push(l);
    loopsByVerdictStepId.set(l.verdictStepId, arr);
  }
  const loopIterations = new Map<string, number>();

  const phases = spec.phases;
  const phaseIdx = new Map(phases.map((p, i) => [p, i] as const));
  for (const s of steps) {
    if (!phaseIdx.has(s.phase)) {
      throw new Error(
        `Step ${s.id} uses phase '${s.phase}' but spec.phases does not include it. Add it to phases.`,
      );
    }
  }

  const wantedPhase = opts.phase;
  const untilPhase = opts.until;

  const startIdx = wantedPhase ? phaseIdx.get(wantedPhase) : 0;
  if (wantedPhase && startIdx === undefined) {
    throw new Error(`--phase '${wantedPhase}' is not in spec.phases`);
  }
  const untilIdx = untilPhase ? phaseIdx.get(untilPhase) : phases.length - 1;
  if (untilPhase && untilIdx === undefined) {
    throw new Error(`--until '${untilPhase}' is not in spec.phases`);
  }

  const phaseAllowed = (phase: string) => {
    const idx = phaseIdx.get(phase);
    if (idx === undefined) {
      return false;
    }
    if (startIdx !== undefined && idx < startIdx) {
      return false;
    }
    if (untilIdx !== undefined && idx > untilIdx) {
      return false;
    }
    return true;
  };

  const getReadySteps = () => {
    return steps.filter((s) => {
      if (completed.has(s.id)) {
        return false;
      }
      if (!phaseAllowed(s.phase)) {
        return false;
      }
      const deps = s.dependsOn ?? [];
      if (!deps.every((d) => completed.has(d))) {
        return false;
      }
      const reqFiles = s.requiresFiles ?? [];
      if (reqFiles.length && !filesExist(workspaceRoot, reqFiles)) {
        return false;
      }
      return true;
    });
  };

  const runOne = async (stepId: string) => {
    const step = stepById.get(stepId);
    if (!step) {
      throw new Error(`Unknown step: ${stepId}`);
    }

    const rec: StepRunRecord = {
      id: step.id,
      phase: step.phase,
      model: step.model,
      startedAt: now(),
    };
    records.push(rec);

    if (opts.dryRun) {
      rec.status = "dry_run";
      rec.endedAt = now();
      completed.add(step.id);
      return;
    }

    const msg = step.task;
    const res = await runAgentTurn({
      agentId: spec.agentId,
      sessionKey,
      message: msg,
      timeoutMs: 30 * 60 * 1000,
    });
    rec.runId = res.runId;
    rec.status = res.status;

    const produces = step.producesFiles ?? [];
    if (produces.length) {
      const startWait = now();
      while (!filesExist(workspaceRoot, produces)) {
        if (now() - startWait > 30 * 60 * 1000) {
          rec.error = `Timeout waiting for outputs: ${produces.join(", ")}`;
          break;
        }
        sleep(1000);
      }
    }

    rec.endedAt = now();
    completed.add(step.id);

    // Loop evaluation: if this step controls any loops, parse verdict and rerun target steps.
    const loopRules = loopsByVerdictStepId.get(step.id) ?? [];
    for (const rule of loopRules) {
      const iter = (loopIterations.get(rule.id) ?? 0) + 1;
      loopIterations.set(rule.id, iter);

      const onVerdicts = rule.on ?? ["WARN", "FAIL"];

      const verdictFile = step.verdictFile;
      if (!verdictFile) {
        throw new Error(
          `Loop '${rule.id}' references verdictStepId '${rule.verdictStepId}' but that step has no verdictFile`,
        );
      }

      const verdictText = readVerdictFromFile(workspaceRoot, verdictFile);
      const verdict = parseVerdict(verdictText);
      rec.meta = { ...rec.meta, verdict, verdictFile };

      if (verdict === "PASS") {
        continue;
      }

      if (verdict === "ABORT") {
        throw new Error(`Loop '${rule.id}' aborted (verdict ABORT in ${verdictFile})`);
      }

      if (
        verdict !== "UNKNOWN" &&
        verdict !== "PASS" &&
        verdict !== "WARN" &&
        verdict !== "FAIL" &&
        verdict !== "ABORT"
      ) {
        continue;
      }
      if (verdict !== "UNKNOWN" && !onVerdicts.includes(verdict)) {
        continue;
      }

      const maxIterations = rule.maxIterations ?? 3;
      if (iter >= maxIterations) {
        throw new Error(
          `Loop '${rule.id}' exceeded maxIterations (${maxIterations}); last verdict=${verdict} (file ${verdictFile})`,
        );
      }

      const fixOutRel = path.join(
        spec.runDir,
        `loop-${rule.id}-iter-${String(iter).padStart(2, "0")}-fixplan.md`,
      );
      const fixOutAbs = absPath(workspaceRoot, fixOutRel);

      // Ask the agent to generate a fix plan and write it directly to the file.
      const fixPlanPrompt =
        `You are running inside a verification pipeline.\n\n` +
        `The pipeline produced a verdict that was not PASS.\n` +
        `Your job: write a concise, actionable FIX PLAN that will help the next rerun pass.\n\n` +
        `Write the fix plan to this exact file path (overwrite if exists):\n` +
        `${fixOutAbs}\n\n` +
        `The fix plan should be markdown and include:\n` +
        `- bullet list of issues observed\n` +
        `- bullet list of concrete changes to make\n` +
        `- if you need more data, specify exactly which file(s) to inspect next\n\n` +
        `After writing the file, reply with ONLY: OK\n\n` +
        `Verdict file path: ${verdictFile}\n\n` +
        `Verdict file contents:\n\n` +
        `---\n${verdictText}\n---\n`;

      const fixRes = await runAgentTurn({
        agentId: spec.agentId,
        sessionKey,
        message: fixPlanPrompt,
        timeoutMs: 10 * 60 * 1000,
      });

      // Gate on the file existing.
      const startWait = now();
      while (!fs.existsSync(fixOutAbs)) {
        if (now() - startWait > 10 * 60 * 1000) {
          throw new Error(`Timeout waiting for fix plan file: ${fixOutRel}`);
        }
        sleep(500);
      }

      rec.meta = {
        ...rec.meta,
        fixPlanFile: fixOutRel,
        fixPlanRunId: fixRes.runId,
        fixPlanStatus: fixRes.status,
      };

      // Mark rerun targets as incomplete so scheduler can pick them up again.
      for (const rerunId of rule.rerunStepIds) {
        if (!stepById.has(rerunId)) {
          throw new Error(`Loop '${rule.id}' rerunStepIds references unknown step '${rerunId}'`);
        }
        completed.delete(rerunId);
      }

      // eslint-disable-next-line no-console
      console.log(
        `[pipeline] loop '${rule.id}' iteration ${iter}/${maxIterations} (verdict=${verdict}); wrote ${fixOut.outRel}; rerunning: ${rule.rerunStepIds.join(
          ", ",
        )}`,
      );
    }
  };

  const checkpointsByPhase = new Map((spec.checkpoints ?? []).map((c) => [c.afterPhase, c]));
  const checkpointed = new Set<string>();

  const runCheckpoint = async (afterPhase: string) => {
    const cp = checkpointsByPhase.get(afterPhase);
    if (!cp) {
      return;
    }
    if (checkpointed.has(cp.id)) {
      return;
    }
    checkpointed.add(cp.id);

    if (opts.yes || cp.interactive === false) {
      // eslint-disable-next-line no-console
      console.log(`[pipeline] checkpoint ${cp.id} skipped (--yes)`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`\n[pipeline] CHECKPOINT: ${cp.id}`);
    // eslint-disable-next-line no-console
    console.log(cp.prompt);
    // eslint-disable-next-line no-console
    console.log("Run again with --yes to continue past checkpoints.");

    throw new Error(`Checkpoint '${cp.id}' requires confirmation (re-run with --yes)`);
  };

  // Simple scheduler: run by groups. Steps without group run serially.
  while (true) {
    const ready = getReadySteps();
    if (ready.length === 0) {
      break;
    }

    const byGroup = new Map<string, string[]>();
    const serial: string[] = [];
    for (const s of ready) {
      if (s.group) {
        const arr = byGroup.get(s.group) ?? [];
        arr.push(s.id);
        byGroup.set(s.group, arr);
      } else {
        serial.push(s.id);
      }
    }

    // Run all grouped steps in parallel, group by group.
    for (const [group, ids] of byGroup) {
      // eslint-disable-next-line no-console
      console.log(`[pipeline] group ${group}: ${ids.join(", ")}`);
      await Promise.all(ids.map((id) => runOne(id)));
    }

    for (const id of serial) {
      // eslint-disable-next-line no-console
      console.log(`[pipeline] step ${id}`);
      await runOne(id);
    }

    // Checkpoints: if there is a checkpoint after a phase and no remaining steps exist in that phase,
    // then fire it.
    for (const phase of phases) {
      if (!phaseAllowed(phase)) {
        continue;
      }
      const remainingInPhase = steps.some(
        (s) => s.phase === phase && !completed.has(s.id) && phaseAllowed(s.phase),
      );
      if (!remainingInPhase) {
        await runCheckpoint(phase);
      }
    }
  }

  const summary = {
    ok: true,
    name: spec.name,
    runDir: spec.runDir,
    stepsRun: records.length,
    records,
  };

  const outPath = absPath(workspaceRoot, path.join(spec.runDir, "pipeline-run-summary.json"));
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  return summary;
}
