import { Command } from "commander";
import { formatRuntimeLogCallArg } from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

export type GatewayCallRequest = {
  clientName?: string;
  method?: string;
  mode?: string;
  params?: unknown;
  scopes?: string[];
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: unknown;
  requireLocalBackendSharedAuth?: boolean;
};

export async function createNodesProgram(
  register: typeof import("./nodes-cli.js").registerNodesCli,
) {
  const program = new Command();
  program.exitOverride();
  await register(program);
  return program;
}

export function gatewayRequests(): GatewayCallRequest[] {
  return programGatewayCallMock.mock.calls.map(([request]) => request as GatewayCallRequest);
}

export function getRuntimeOutput() {
  return runtime.log.mock.calls.map(([value]) => formatRuntimeLogCallArg(value)).join("\n");
}

export function mockGateway(
  reply: ((request: GatewayCallRequest) => unknown) | Record<string, unknown>,
) {
  programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
    const request = (args[0] ?? {}) as GatewayCallRequest;
    if (typeof reply === "function") {
      return reply(request);
    }
    const response = reply[request.method ?? ""] ?? { ok: true };
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
}
