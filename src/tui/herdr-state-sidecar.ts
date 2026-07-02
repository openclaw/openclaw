// Bridges OpenClaw TUI status text into Herdr pane agent state reports.
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HerdrOpenClawState = "idle" | "working" | "blocked" | "unknown";

export type HerdrStateReport = {
  state: HerdrOpenClawState;
  customStatus: string;
};

export type HerdrSidecarLogger = Pick<Console, "debug" | "warn">;

export type HerdrSidecarHandle = {
  stop: () => void;
};

type HerdrExec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const IDLE_RE = /gateway connected \| idle/i;
const SPINNER_RE = /[\u2800-\u28ff]/;
const APPROVAL_RES = [
  /approve this command\?/i,
  /allow once/i,
  /requires approval/i,
  /approval required/i,
];

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isPaneGoneError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as ExecFileException & { stderr?: string; stdout?: string };
  const text = `${err.message ?? ""}\n${err.stderr ?? ""}\n${err.stdout ?? ""}`;
  return /\b(pane|not found|unknown|no such)\b/i.test(text);
}

function normalizeHerdrPaneId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parsePollingIntervalMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1000;
  }
  return Math.max(250, Math.floor(parsed));
}

export function detectHerdrOpenClawState(content: string): HerdrStateReport {
  if (!content) {
    return { state: "unknown", customStatus: "" };
  }
  for (const approvalRe of APPROVAL_RES) {
    if (approvalRe.test(content)) {
      return { state: "blocked", customStatus: "awaiting-approval" };
    }
  }
  if (SPINNER_RE.test(content) && content.includes("| connected")) {
    const elapsed = /\u2026 \u2022 ((?:\d+m\s+)?\d+s)/.exec(content)?.[1] ?? "thinking";
    return { state: "working", customStatus: elapsed };
  }
  if (IDLE_RE.test(content)) {
    return { state: "idle", customStatus: "" };
  }
  return { state: "unknown", customStatus: "" };
}

export async function readHerdrPane(params: {
  paneId: string;
  exec?: HerdrExec;
  timeoutMs?: number;
}): Promise<string> {
  const run = params.exec ?? execFileAsync;
  const result = await run(
    "herdr",
    ["pane", "read", params.paneId, "--source", "visible", "--lines", "80"],
    { timeout: params.timeoutMs ?? 5000 },
  );
  return result.stdout;
}

export async function reportHerdrState(params: {
  paneId: string;
  report: HerdrStateReport;
  agentLabel?: string;
  exec?: HerdrExec;
  timeoutMs?: number;
}): Promise<void> {
  const run = params.exec ?? execFileAsync;
  const args = [
    "pane",
    "report-agent",
    params.paneId,
    "--source",
    "custom:openclaw",
    "--agent",
    params.agentLabel ?? "openclaw",
    "--state",
    params.report.state,
  ];
  if (params.report.customStatus) {
    args.push("--custom-status", params.report.customStatus);
  }
  await run("herdr", args, { timeout: params.timeoutMs ?? 5000 });
}

export function startHerdrStateSidecar(params?: {
  env?: NodeJS.ProcessEnv;
  exec?: HerdrExec;
  logger?: HerdrSidecarLogger;
}): HerdrSidecarHandle | null {
  const env = params?.env ?? process.env;
  if (isTruthyEnvValue(env.OPENCLAW_HERDR_STATE_DISABLE)) {
    return null;
  }
  const paneId = normalizeHerdrPaneId(env.HERDR_PANE_ID);
  if (!paneId) {
    return null;
  }

  const exec = params?.exec ?? execFileAsync;
  const logger = params?.logger;
  const intervalMs = parsePollingIntervalMs(env.OPENCLAW_HERDR_STATE_INTERVAL_MS);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastKey = "";

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    try {
      const content = await readHerdrPane({ paneId, exec });
      const report = detectHerdrOpenClawState(content);
      const key = `${report.state}:${report.customStatus}`;
      if (key !== lastKey) {
        await reportHerdrState({ paneId, report, exec });
        lastKey = key;
      }
    } catch (error) {
      if (isPaneGoneError(error)) {
        stopped = true;
        logger?.debug(`herdr-state: pane ${paneId} gone; stopping`);
        return;
      }
      logger?.warn(`herdr-state: ${String(error)}`);
    } finally {
      schedule();
    }
  };

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
