import { resolveCurrentOpenClawCliInvocation } from "../infra/openclaw-cli-invocation.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  attachClawRemoveGatewayBridge,
  type ClawRemoveGatewayBridge,
} from "./gateway-remove-bridge.js";
import { CLAW_REMOVE_GATEWAY_BRIDGE_ENV } from "./remove-gateway-bridge-protocol.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const REMOVE_APPLY_KILL_GRACE_MS = 5_000;

export type ClawRemoveCliResponse = {
  code: number;
  payload: unknown;
};

export async function runClawRemoveCli(input: {
  agentId: string;
  planIntegrity?: string;
  signal?: AbortSignal;
  gatewayBridge?: ClawRemoveGatewayBridge;
}): Promise<ClawRemoveCliResponse> {
  if (input.gatewayBridge?.previewOnly && input.planIntegrity) {
    throw new Error("Gateway Claw removal preview bridge cannot apply a plan.");
  }
  if (input.gatewayBridge && !input.gatewayBridge.previewOnly && !input.planIntegrity) {
    throw new Error("Gateway Claw removal bridge requires the reviewed plan.");
  }
  const invocation = resolveCurrentOpenClawCliInvocation(
    [
      "claws",
      "remove",
      input.agentId,
      "--exact-agent-id",
      ...(input.planIntegrity ? ["--yes", "--plan-integrity", input.planIntegrity] : ["--dry-run"]),
      "--json",
    ],
    { moduleUrl: import.meta.url },
  );
  const bridgeController = input.gatewayBridge ? new AbortController() : undefined;
  const signal = bridgeController
    ? input.signal
      ? AbortSignal.any([input.signal, bridgeController.signal])
      : bridgeController.signal
    : input.signal;
  const result = await runCommandBuffered([invocation.command, ...invocation.args], {
    cwd: invocation.cwd,
    env: {
      ...invocation.env,
      [CLAW_REMOVE_GATEWAY_BRIDGE_ENV]: input.gatewayBridge ? "1" : "0",
      ...(input.gatewayBridge ? { OPENCLAW_NO_RESPAWN: "1", NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
    },
    ...(signal ? { signal } : {}),
    ...(input.gatewayBridge
      ? {
          onPrivateControlChild: (child: Parameters<typeof attachClawRemoveGatewayBridge>[0]) =>
            attachClawRemoveGatewayBridge(child, input.gatewayBridge!, (reason) =>
              bridgeController?.abort(reason),
            ),
        }
      : {}),
    timeoutMs: input.planIntegrity ? 600_000 : 90_000,
    ...(input.planIntegrity ? { killGraceMs: REMOVE_APPLY_KILL_GRACE_MS } : {}),
    maxOutputBytes: { stdout: MAX_STDOUT_BYTES, stderr: MAX_STDERR_BYTES },
    maxCombinedOutputBytes: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
    killProcessTree: true,
  });
  if (result.termination !== "exit" || result.code === null) {
    throw new Error("The Claw removal command did not complete.");
  }
  try {
    return { code: result.code, payload: JSON.parse(result.stdout.toString("utf8")) as unknown };
  } catch {
    throw new Error("The Claw removal command returned an invalid result.");
  }
}
