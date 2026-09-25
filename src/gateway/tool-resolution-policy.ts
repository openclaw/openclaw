import path from "node:path";
import { prepareDelegatedToolParameterTarget } from "../agents/delegated-tool-parameter-target.js";
import { captureDelegatedToolParameters } from "../agents/inherited-tool-parameters.js";
import {
  captureDelegatedSourceToolPolicy,
  captureInheritedToolPolicy,
} from "../agents/inherited-tool-policy.js";
import type { InheritedToolPolicySourceCapture } from "../agents/inherited-tool-policy.schema.js";
import type { PreparedRootedExecutionCapability } from "../agents/rooted-run-params.js";
import type { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";

/** Project actual Gateway execution facts before capturing source delegation authority. */
export function prepareGatewayDelegationToolPolicy(params: {
  request: Pick<
    McpLoopbackRequestContext,
    | "execSession"
    | "execOverrides"
    | "scheduledToolPolicy"
    | "bashElevated"
    | "modelProvider"
    | "modelId"
    | "approvalReviewerDeviceId"
  > & {
    cfg: OpenClawConfig;
    rootedExecution?: PreparedRootedExecutionCapability;
    assertInvocationCurrent?: () => void;
    isGrantCurrent?: () => boolean;
  };
  agentId: string;
  workspaceDir: string;
  sandbox: ReturnType<typeof resolveSandboxRuntimeStatus>;
  capture: Omit<Parameters<typeof captureInheritedToolPolicy>[0], "parameters">;
}) {
  const request = params.request;
  const parameterFacts = prepareDelegatedToolParameterTarget({
    config: request.cfg,
    agentId: params.agentId,
    sessionEntry: request.execSession ?? null,
    sessionPermissionPolicy:
      request.rootedExecution?.sessionPermissionPolicy ??
      (request.execSession?.permissionMode
        ? { root: params.workspaceDir, mode: request.execSession.permissionMode }
        : undefined),
    rootIsWorkspace:
      !request.rootedExecution ||
      Boolean(request.rootedExecution.sandbox) ||
      path.resolve(request.rootedExecution.root) === path.resolve(params.workspaceDir),
    execOverrides: request.execOverrides,
    scheduledExecTarget: request.scheduledToolPolicy?.execTarget,
    elevated: request.bashElevated ?? null,
    sandbox: params.sandbox,
    modelProvider: request.modelProvider,
    modelId: request.modelId,
    requireWorkspaceOnly: request.rootedExecution !== undefined,
  });
  const preparedSandbox = request.rootedExecution?.sandbox;
  if (preparedSandbox) {
    parameterFacts.sandbox.config = {
      ...parameterFacts.sandbox.config,
      backend: preparedSandbox.backendId,
      workspaceAccess: preparedSandbox.workspaceAccess,
      docker: preparedSandbox.docker,
      browser: {
        ...parameterFacts.sandbox.config.browser,
        enabled: Boolean(preparedSandbox.browser),
        allowHostControl: preparedSandbox.browserAllowHostControl,
      },
    };
  }
  parameterFacts.exec.approvalReviewerDeviceId = request.approvalReviewerDeviceId;
  const capturedPolicy = captureInheritedToolPolicy({
    ...params.capture,
    parameters: captureDelegatedToolParameters(parameterFacts),
  });
  const captureSource: InheritedToolPolicySourceCapture = async () => {
    const assertCurrent = () => {
      request.assertInvocationCurrent?.();
      if (request.isGrantCurrent && !request.isGrantCurrent()) {
        throw new Error("Gateway tool invocation grant is no longer active");
      }
    };
    const policy = await captureDelegatedSourceToolPolicy({
      policy: capturedPolicy,
      exec: parameterFacts.exec,
      sandboxed: params.sandbox.sandboxed,
      config: request.cfg,
      agentId: params.agentId,
      assertCurrent,
    });
    assertCurrent();
    return { policy, assertCurrent };
  };
  return { parameterFacts, captureSource };
}
