/** Shared loose cron fixtures for isolated-agent tests. */
type LooseRecord = Record<string, unknown>;

/** Builds a loose cron job fixture for isolated-agent unit tests. */
export function makeIsolatedAgentJobFixture(overrides?: LooseRecord) {
  const payload = { kind: "agentTurn", message: "test" };
  return {
    id: "test-job",
    name: "Test Job",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    scheduledNativePolicy: { version: 1, mode: "inherit" },
    ...overrides,
    payload: {
      toolsAllow: ["*"],
      toolsAllowIsDefault: true,
      ...(overrides?.payload ? (overrides.payload as LooseRecord) : payload),
    },
  } as never;
}

export function makeIsolatedAgentParamsFixture(overrides?: LooseRecord) {
  // Keep the fixture deliberately loose so tests can pass partial CronJob shapes
  // without repeating unrelated scheduler defaults.
  const jobOverrides =
    overrides && "job" in overrides ? (overrides.job as LooseRecord | undefined) : undefined;
  const { job: _job, ...paramOverrides } = overrides ?? {};
  return {
    cfg: {},
    deps: {} as never,
    job: makeIsolatedAgentJobFixture(jobOverrides),
    message: "test",
    sessionKey: "cron:test",
    ...paramOverrides,
  };
}
