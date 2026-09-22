type RestartPostCheckContext = {
  activationAccepted: boolean;
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

export type RestartParams = {
  opts?: { json?: boolean };
  beforeServiceMutation?: () => void;
  repairLoadedService?: (ctx: {
    json: boolean;
    stdout: NodeJS.WritableStream;
    state: unknown;
    issues: unknown[];
  }) => Promise<unknown>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

export function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

export async function expectRestartError(
  promise: Promise<unknown>,
): Promise<Error & { hints?: string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { hints?: string[] };
  }
  throw new Error("expected restart to fail");
}

export type RestartHealthSnapshot = {
  healthy: boolean;
  staleGatewayPids: number[];
  runtime: { status?: string };
  portUsage: { port: number; status: string; listeners: []; hints: []; errors?: string[] };
  waitOutcome?: string;
  elapsedMs?: number;
};

export function createHealthyRestartSnapshot(): RestartHealthSnapshot {
  return {
    healthy: true,
    staleGatewayPids: [],
    runtime: { status: "running" },
    portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
  };
}

export function failRestartCheck(message: string, hints?: string[]) {
  const error: Error & { hints?: string[] } = new Error(message);
  error.hints = hints;
  throw error;
}
