import { isTruthyEnvValue } from "./env.js";

type CliTimingEntry = {
  label: string;
  ms: number;
};

type CliTimingPayload = {
  type: "clawdbot.cli.timing";
  pid: number;
  entries: CliTimingEntry[];
  extra?: Record<string, unknown> | null;
};

const enabled = isTruthyEnvValue(process.env.CLAWDBOT_CLI_TIMING);
let emitted = false;
let disabled = false;

const startNs = (() => {
  if (!enabled) return 0n;
  const envStart = process.env.CLAWDBOT_CLI_START_NS;
  if (envStart) {
    try {
      return BigInt(envStart);
    } catch {
      // ignore
    }
  }
  const now = process.hrtime.bigint();
  process.env.CLAWDBOT_CLI_START_NS = String(now);
  return now;
})();

const marks: Array<{ label: string; ns: bigint }> = [];

const toMs = (ns: bigint) => Number(ns) / 1_000_000;

const buildEntries = (endNs: bigint): CliTimingEntry[] => {
  const entries: CliTimingEntry[] = [{ label: "start", ms: 0 }];
  for (const mark of marks) {
    entries.push({ label: mark.label, ms: toMs(mark.ns - startNs) });
  }
  entries.push({ label: "end", ms: toMs(endNs - startNs) });
  return entries;
};

const emitTiming = (extra?: Record<string, unknown> | null) => {
  if (!enabled || emitted || disabled) return;
  emitted = true;
  const endNs = process.hrtime.bigint();
  const payload: CliTimingPayload = {
    type: "clawdbot.cli.timing",
    pid: process.pid,
    entries: buildEntries(endNs),
    extra: extra ?? null,
  };
  try {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // ignore timing failures
  }
};

if (enabled) {
  process.once("exit", () => {
    emitTiming({ exitCode: process.exitCode ?? 0 });
  });
}

export function getCliTiming(): {
  mark: (label: string) => void;
  emit: (extra?: Record<string, unknown> | null) => void;
} | null {
  if (!enabled || disabled) return null;
  return {
    mark: (label: string) => {
      if (!enabled || disabled) return;
      marks.push({ label, ns: process.hrtime.bigint() });
    },
    emit: (extra?: Record<string, unknown> | null) => {
      emitTiming(extra);
    },
  };
}

export function disableCliTiming(): void {
  disabled = true;
}
