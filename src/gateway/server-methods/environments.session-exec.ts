import {
  ErrorCodes,
  errorShape,
  validateEnvironmentsSessionExecParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareExecDefaults } from "../../agents/exec-defaults.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "../../config/sessions/session-entry-source-authority.js";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { prepareExecApprovalsCurrentRead } from "../../infra/exec-approvals-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { approveSessionEnvironmentCommand } from "./environments.session-exec-approval.js";
import { captureSessionEnvironmentToolPolicy } from "./environments.session-tool-policy.js";
import { resolveSessionEnvironmentCaller } from "./environments.session.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const environmentsSessionExecHandlers: GatewayRequestHandlers = {
  "environments.session.exec": defineValidatedGatewayMethod(
    "environments.session.exec",
    validateEnvironmentsSessionExecParams,
    async (options) => {
      const { params, respond, context } = options;
      const caller = await resolveSessionEnvironmentCaller(options, params);
      let policyAuthority: Awaited<ReturnType<typeof prepareSessionSourceAuthority>> | undefined;
      try {
        const scope = {
          ...caller.identity,
          storePath: resolveSessionStorePathForScope(caller.identity, context.getRuntimeConfig()),
        };
        const policyEntry = await readSessionEntryReadOnlyInWorker(scope, caller.assertCurrent);
        policyAuthority = await prepareSessionSourceAuthority(
          captureSessionEntrySourceAssertion({
            scope,
            expected: policyEntry,
            fields: [
              "sessionId",
              "lifecycleRevision",
              "execHost",
              "execNode",
              "permissionMode",
              "sandbox",
              "sandboxMode",
              "createdActor",
            ],
            assertCurrent: caller.assertCurrent,
            assertHostCurrent: caller.assertCurrent,
            refuse() {
              throw new Error("The selected session changed before its operation committed.");
            },
          }),
        );
        const service = context.workerEnvironmentService;
        const binding = service?.getSessionAttachment(caller.identity.sessionId);
        if (
          !service ||
          !binding ||
          (params.environmentId !== undefined && params.environmentId !== binding.environmentId)
        ) {
          throw new Error("No matching environment is attached to this conversation");
        }
        const action = params.action ?? "run";
        const command = {
          argv: params.argv ? [...params.argv] : ["openclaw-internal-workspace-process"],
          input: params.input,
          timeoutMs: params.timeoutMs,
          processId: params.processId,
        };
        const toolPolicy = captureSessionEnvironmentToolPolicy(
          options,
          caller,
          action === "run" || action === "start" ? "exec" : "process",
        );
        const readApprovals = await prepareExecApprovalsCurrentRead(
          captureOpenClawStateWorkerContext(),
        );
        let approved = false;
        const resolvePolicy = () => {
          const cfg = context.getRuntimeConfig();
          policyAuthority!.assertCurrent();
          const preparation = prepareExecDefaults(
            {
              cfg,
              ...caller.identity,
              sessionEntry: policyEntry,
            },
            resolveSandboxRuntimeStatus({
              cfg,
              ...caller.identity,
              preparedSessionEntry: policyEntry ?? null,
            }),
          );
          return preparation.kind === "resolved"
            ? preparation.defaults
            : preparation.resolve(readApprovals());
        };
        const requiresApproval = (policy: ReturnType<typeof resolvePolicy>) =>
          policy.security !== "full" || policy.ask === "always" || toolPolicy.cronExecAskAlways;
        const assertCurrent = () => {
          toolPolicy.assertAllowed();
          service.assertSessionAttachment(binding);
          const defaults = resolvePolicy();
          if (defaults.security === "deny") {
            throw new Error("Conversation policy denies environment command execution");
          }
          if (action === "run" || action === "start") {
            if (defaults.security === "allowlist" && defaults.ask === "off") {
              throw new Error(
                "Attached environment commands cannot inherit this host's executable allowlist",
              );
            }
            if (defaults.effectiveHost !== "gateway") {
              throw new Error("The conversation's exec policy binds commands to a different host");
            }
          }
          return defaults;
        };
        const initialPolicy = assertCurrent();
        if ((action === "run" || action === "start") && requiresApproval(initialPolicy)) {
          await approveSessionEnvironmentCommand({
            options,
            binding,
            argv: command.argv,
            input: command.input,
            background: action === "start",
            assertCurrent,
            signal: caller.signal,
          });
          approved = true;
        }
        const assertDispatch = () => {
          const policy = assertCurrent();
          if (action === "run" || action === "start") {
            if (!approved && requiresApproval(policy)) {
              throw new Error(
                "Environment execution policy now requires approval; retry the command",
              );
            }
          }
        };
        assertDispatch();
        const result = await service.execSessionAttachment(binding, {
          argv: command.argv,
          ...(command.input === undefined ? {} : { input: command.input }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
          ...(action === "run" ? {} : { process: { action, processId: command.processId! } }),
          transportRetry: "never",
          signal: caller.signal,
          assertCurrent: assertDispatch,
        });
        assertCurrent();
        respond(true, { environmentId: binding.environmentId, ...result });
      } finally {
        try {
          await policyAuthority?.release?.();
        } finally {
          caller.release();
        }
      }
    },
    (error) =>
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : "Environment execution failed",
      ),
  ),
};
