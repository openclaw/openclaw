import { getCommandPathWithRootOptions, getFlagValue, hasHelpOrVersion } from "./argv.js";

const LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS = 30_000;
const LOCAL_AGENT_HARD_TIMEOUT_GRACE_SECONDS = LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS / 1000;

type LocalAgentHardTimeoutDeps = {
  argv?: string[];
  setTimeout?: typeof globalThis.setTimeout;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  exit?: (code?: number) => never | void;
};

type LocalAgentTimeoutPlan = {
  timeoutMs: number;
  timeoutSeconds: number;
};

function parseExplicitTimeoutSeconds(argv: string[]): number | undefined {
  const raw = getFlagValue(argv, "--timeout");
  if (raw === undefined || raw === null || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveLocalAgentHardTimeoutPlan(
  deps: LocalAgentHardTimeoutDeps = {},
): LocalAgentTimeoutPlan | null {
  const argv = deps.argv ?? process.argv;
  const commandPath = getCommandPathWithRootOptions(argv, 1);
  if (commandPath[0] !== "agent" || hasHelpOrVersion(argv)) {
    return null;
  }
  const localFlag = getFlagValue(argv, "--local");
  if (localFlag === undefined) {
    return null;
  }
  const overrideSeconds = parseExplicitTimeoutSeconds(argv);
  if (overrideSeconds === undefined) {
    // Keep omitted --timeout on the existing configured/default agent timeout contract.
    return null;
  }
  if (overrideSeconds === 0) {
    return null;
  }
  return {
    timeoutMs: overrideSeconds * 1000 + LOCAL_AGENT_HARD_TIMEOUT_GRACE_MS,
    timeoutSeconds: overrideSeconds,
  };
}

export function armLocalAgentHardTimeout(deps: LocalAgentHardTimeoutDeps = {}): void {
  const plan = resolveLocalAgentHardTimeoutPlan(deps);
  if (!plan) {
    return;
  }
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? process.exit.bind(process);
  const timer = setTimer(() => {
    try {
      stderr.write(
        `local agent command timed out after ${plan.timeoutSeconds}s plus ${LOCAL_AGENT_HARD_TIMEOUT_GRACE_SECONDS}s grace\n`,
      );
    } catch {}
    try {
      exit(124);
    } catch {}
  }, plan.timeoutMs);
  timer.unref?.();
}

export function exitAfterCliCompletion(): never {
  process.exit(process.exitCode ?? 0);
}
