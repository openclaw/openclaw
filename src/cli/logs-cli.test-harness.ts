// Shared mocked transports and output capture for the registered logs CLI tests.
import { afterEach, beforeEach, vi } from "vitest";
import { GatewayTransportError } from "../gateway/call.js";
import type { RuntimeExitOptions } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerLogsCli } from "./logs-cli.js";

const { MockGatewayTransportError } = vi.hoisted(() => ({
  MockGatewayTransportError: class extends Error {
    readonly kind: string;
    readonly connectionDetails: unknown;
    readonly code?: number;
    readonly reason?: string;
    readonly timeoutMs?: number;

    constructor(params: {
      kind: string;
      message: string;
      connectionDetails: unknown;
      code?: number;
      reason?: string;
      timeoutMs?: number;
    }) {
      super(params.message);
      this.name = "GatewayTransportError";
      this.kind = params.kind;
      this.connectionDetails = params.connectionDetails;
      if (params.code !== undefined) {
        this.code = params.code;
      }
      if (params.reason !== undefined) {
        this.reason = params.reason;
      }
      if (params.timeoutMs !== undefined) {
        this.timeoutMs = params.timeoutMs;
      }
    }
  },
}));

export const callGatewayFromCli = vi.fn();
export const readConfiguredLogTail = vi.fn();
export const readSystemdServiceRuntime = vi.fn();
export const execFileUtf8Tail = vi.fn();
export const buildGatewayConnectionDetails = vi.fn(
  (_options?: {
    configPath?: string;
    config?: unknown;
    url?: string;
    urlSource?: "cli" | "env";
  }) => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
);

vi.mock("../gateway/call.js", () => ({
  GatewayTransportError: MockGatewayTransportError,
  buildGatewayConnectionDetails: (
    ...args: Parameters<typeof import("../gateway/call.js").buildGatewayConnectionDetails>
  ) => buildGatewayConnectionDetails(...args),
  isGatewayTransportError: (value: unknown) => value instanceof MockGatewayTransportError,
}));

vi.mock("../logging/log-tail.js", () => ({
  readConfiguredLogTail: (
    ...args: Parameters<typeof import("../logging/log-tail.js").readConfiguredLogTail>
  ) => readConfiguredLogTail(...args),
}));

vi.mock("./logs-cli.runtime.js", () => ({
  buildGatewayConnectionDetails: (
    ...args: Parameters<typeof import("../gateway/call.js").buildGatewayConnectionDetails>
  ) => buildGatewayConnectionDetails(...args),
  readSystemdServiceRuntime: (
    ...args: Parameters<typeof import("../daemon/systemd.js").readSystemdServiceRuntime>
  ) => readSystemdServiceRuntime(...args),
  execFileUtf8Tail: (
    ...args: Parameters<typeof import("./logs-cli.runtime.js").execFileUtf8Tail>
  ) => execFileUtf8Tail(...args),
  resolveGatewaySystemdServiceName: (
    ..._args: Parameters<typeof import("../daemon/constants.js").resolveGatewaySystemdServiceName>
  ) => "openclaw-gateway",
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: vi.fn().mockReturnValue(0),
}));

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  const terminalRestore = await vi.importActual<
    typeof import("../../packages/terminal-core/src/restore.js")
  >("../../packages/terminal-core/src/restore.js");
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      exit: vi.fn((code: number, opts?: RuntimeExitOptions) => {
        terminalRestore.restoreTerminalState("runtime exit", {
          resumeStdinIfPaused: false,
          resetStream: opts?.resetStream,
        });
        process.exit(code);
      }),
    },
  };
});

export async function runLogsCli(argv: string[]) {
  await runRegisteredCli({
    register: registerLogsCli as (program: import("commander").Command) => void,
    argv,
  });
}

export function createGatewayCloseError(params: {
  code: number;
  reason: string;
  message: string;
  url?: string;
  urlSource?: "cli" | "local loopback";
}) {
  return new GatewayTransportError({
    kind: "closed",
    code: params.code,
    reason: params.reason,
    connectionDetails: {
      url: params.url ?? "ws://127.0.0.1:18789",
      urlSource: params.urlSource ?? "local loopback",
      message: "",
    },
    message: params.message,
  });
}

export function captureStdoutWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

export function captureStderrWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

export function useLogsCliTestHarness() {
  beforeEach(() => {
    readSystemdServiceRuntime.mockResolvedValue({ status: "stopped" });
    execFileUtf8Tail.mockResolvedValue({ stdout: "", stderr: "", code: 1, truncated: false });
  });

  afterEach(() => {
    callGatewayFromCli.mockClear();
    readConfiguredLogTail.mockClear();
    buildGatewayConnectionDetails.mockClear();
    readSystemdServiceRuntime.mockClear();
    execFileUtf8Tail.mockClear();
    vi.restoreAllMocks();
  });
}
