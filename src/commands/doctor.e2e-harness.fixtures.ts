export function createGatewayUpdateResult() {
  return {
    status: "skipped",
    mode: "unknown",
    steps: [],
    durationMs: 0,
  } as const;
}

export function createCommandWithTimeoutResult() {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  } as const;
}

export function createLegacyConfigSnapshot() {
  return {
    path: "/tmp/openclaw.json",
    exists: false,
    raw: null,
    parsed: {},
    valid: true,
    config: {},
    issues: [],
    legacyIssues: [],
  } as const;
}
