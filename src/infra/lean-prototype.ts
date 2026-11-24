// PROTOTYPE (perf/lean-1g-prototype): measurement knobs for running lean in 1 GiB.
// Read once from OPENCLAW_LEAN_PROTO, for example "idle=3000,archiveIdle=5000". Not a config
// surface: a shipped version derives these from the resolved lean profile and memory limit.
const knobs = new Map(
  (process.env.OPENCLAW_LEAN_PROTO ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair): [string, number] => {
      const [name = "", value = ""] = pair.split("=");
      return [name, Number(value)];
    })
    .filter(([, value]) => Number.isFinite(value) && value >= 0),
);

export const leanPrototype = {
  /** Idle worker lifetime for pools that already retire idle workers. */
  poolIdleMs: knobs.get("idle"),
  /** Idle lifetime of the SQLite archive carrier and scoped read-only readers. */
  carrierIdleMs: knobs.get("archiveIdle"),
  /** Percent of the memory limit at which idle workers retire; critical 10 points higher. */
  pressurePercent: knobs.get("pressure"),
  /** Idle lifetime for the session history lane, which otherwise keeps its worker until close. */
  historyIdleMs: knobs.get("historyIdle"),
  /** Longest a task waits for memory before it starts a new worker anyway. */
  startWaitMs: knobs.get("wait"),
  /** Pooled workers alive at once; a start beyond this waits for an idle one to retire. */
  maxPoolWorkers: knobs.get("maxWorkers"),
};

/** Shorten an owner's idle retirement; owners that never retire idle workers keep theirs. */
export function leanPrototypeIdleOptions<
  Options extends { idleTimeoutMs?: number; burstIdleTimeoutMs?: number; warmWindowMs?: number },
>(options: Options): Options {
  const idle = leanPrototype.poolIdleMs;
  if (idle === undefined || (options.idleTimeoutMs ?? 60_000) <= idle) {
    return options;
  }
  return {
    ...options,
    idleTimeoutMs: idle,
    burstIdleTimeoutMs:
      options.burstIdleTimeoutMs === undefined
        ? undefined
        : Math.min(options.burstIdleTimeoutMs, idle),
    // A recently recreated worker otherwise stays warm for five minutes.
    warmWindowMs: 0,
  };
}
