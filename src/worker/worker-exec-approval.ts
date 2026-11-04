import { createHash } from "node:crypto";
import type {
  WorkerExecApprovalBinding,
  WorkerExecApprovalParams,
} from "../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { abortable } from "../agents/embedded-agent-runner/run/abortable.js";
import type {
  ExecApprovalExecution,
  ExecApprovalTransport,
} from "../agents/exec-approval-transport.js";
import type { WorkerConnection } from "./worker-connection.js";
import { workerExecApprovalDigest } from "./worker-exec-approval-binding.js";

function bindExecution({ env, ...input }: ExecApprovalExecution): WorkerExecApprovalBinding {
  return {
    ...input,
    environment: createHash("sha256")
      .update(
        JSON.stringify(
          Object.keys(env)
            .toSorted()
            .map((key) => [key, env[key]]),
        ),
      )
      .digest("hex"),
  };
}

export function createWorkerExecApprovalTransport(
  client: Pick<WorkerConnection, "requestExecApproval" | "captureExecApprovalAuthority">,
  toolCallId: string,
  signal?: AbortSignal,
): ExecApprovalTransport {
  const assertConnection = client.captureExecApprovalAuthority();
  let binding: WorkerExecApprovalBinding | undefined;
  let approved: string | undefined;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertConnection();
  };
  const request = async (input: WorkerExecApprovalParams) => {
    assertCurrent();
    const pending = client.requestExecApproval(input);
    const response = await (signal ? abortable(signal, pending) : pending).catch(
      (error: unknown) => {
        throw new Error(
          "Worker exec approval was interrupted or returned no valid decision. Retry from a new worker turn.",
          { cause: error },
        );
      },
    );
    assertCurrent();
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    const result = response.payload;
    if (
      result.operation !== input.operation ||
      result.binding !== workerExecApprovalDigest(input.binding)
    ) {
      throw new Error(
        "Worker exec approval does not match this command. Retry from a new worker turn.",
      );
    }
    if (
      (result.operation === "review" ? result.decision.decision : result.decision) === "allow-once"
    ) {
      approved = result.binding;
    }
    return result;
  };
  const currentBinding = () => {
    assertCurrent();
    if (!binding) {
      throw new Error("Worker exec approval has no command binding");
    }
    return binding;
  };
  return {
    bindExecution(input) {
      assertCurrent();
      binding = bindExecution(input);
      approved = undefined;
    },
    assertExecution(input) {
      assertCurrent();
      if (!binding) {
        return;
      }
      if (!approved || approved !== workerExecApprovalDigest(bindExecution(input))) {
        throw new Error(
          "Worker exec has no matching Gateway decision for this command, directory, environment, and PTY. Retry from a new worker turn.",
        );
      }
    },
    async review(input) {
      const { argv, resolvedPath, envKeys, reason, analysis } = input;
      const result = await request({
        operation: "review",
        toolCallId,
        binding: currentBinding(),
        review: {
          argv: argv ? [...argv] : undefined,
          resolvedPath,
          envKeys: envKeys ? [...envKeys] : undefined,
          reason,
          analysis,
        },
      });
      if (result.operation !== "review") {
        throw new Error("Missing worker review decision");
      }
      return result.decision;
    },
    async request(input) {
      const result = await request({
        id: input.id,
        warningText: input.warningText,
        operation: "request",
        toolCallId,
        binding: currentBinding(),
      });
      if (result.operation !== "request" || result.id !== input.id || result.decision === null) {
        throw new Error("Missing Gateway worker approval decision. Retry from a new worker turn.");
      }
      return {
        id: result.id,
        expiresAtMs: result.expiresAtMs,
        ...(result.decision !== undefined ? { finalDecision: result.decision } : {}),
      };
    },
    async waitDecision(input) {
      const result = await request({
        ...input,
        operation: "wait",
        toolCallId,
        binding: currentBinding(),
      });
      if (result.operation !== "wait" || result.decision === null) {
        throw new Error("No Gateway exec decision. Retry from a new worker turn.");
      }
      return result;
    },
  };
}
