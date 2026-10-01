import crypto from "node:crypto";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  InstalledAppLaunchRequestSchema,
  InstalledAppLaunchToolParamsSchema,
  InstalledAppStartedSchema,
  NODE_INSTALLED_APP_LAUNCH_COMMAND,
} from "../../infra/installed-app-launch.js";
import { formatExecCommand } from "../../infra/system-run-command.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import { invokeNodeSystemRun } from "../bash-tools.exec-host-node-failure.js";
import { executeNodeHostCommand } from "../bash-tools.exec-host-node.js";
import { withPreparedExecDefaults } from "../exec-defaults.preparation.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { withPreparedToolConstruction } from "../tool-construction-preparation.js";
import { jsonResult } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { listNodes } from "./nodes-utils.js";

export type InstalledAppToolContext = Pick<
  OpenClawToolsOptions,
  | "config"
  | "agentSessionKey"
  | "sessionId"
  | "execSession"
  | "execOverrides"
  | "approvalReviewerDeviceIds"
  | "agentChannel"
  | "agentTo"
  | "agentAccountId"
  | "agentThreadId"
> & { agentId: string };
const DescriptorSchema = InstalledAppLaunchRequestSchema.extend({
  executable: z.string().startsWith("/"),
}).strip();

/** Optional native operation; ordinary exec owns every policy and approval decision. */
export async function executeInstalledAppLaunch(
  request: z.infer<typeof InstalledAppLaunchToolParamsSchema>,
  options: InstalledAppToolContext,
  toolCallId: string,
  signal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(signal);
  return await withPreparedToolConstruction(
    options.config,
    { signal, assertCurrent },
    async (prepared) =>
      await withPreparedExecDefaults(
        {
          cfg: prepared.config,
          agentId: options.agentId,
          sessionKey: options.agentSessionKey,
          sessionEntry: options.execSession,
          execOverrides: options.execOverrides,
        },
        prepared,
        async (defaults) => {
          assertCurrent();
          if (defaults.security === "deny") {
            throw new Error("exec denied: host=node security=deny");
          }
          if (!defaults.canRequestNode) {
            throw new Error(
              "exec denied: node target is unavailable under current execution policy",
            );
          }
          const node = (await listNodes({}, signal)).find((entry) => entry.nodeId === request.node);
          if (!node?.commands?.includes(NODE_INSTALLED_APP_LAUNCH_COMMAND)) {
            throw new Error("Exact paired node does not advertise installed-app launch");
          }
          const raw = await callGatewayTool<{ payload?: { apps?: unknown[] } }>(
            "node.invoke",
            {},
            {
              nodeId: node.nodeId,
              command: "device.apps",
              params: { appId: request.appId },
              idempotencyKey: crypto.randomUUID(),
            },
            { signal, requireAgentRuntimeIdentity: true },
          );
          const descriptor = DescriptorSchema.parse(raw.payload?.apps?.[0]);
          if (
            descriptor.appId !== request.appId ||
            descriptor.appRevision !== request.appRevision
          ) {
            throw new Error(
              "INSTALLED_APP_CHANGED: refresh inventory and authorize the current app",
            );
          }
          let started: z.infer<typeof InstalledAppStartedSchema> | undefined;
          const result = await executeNodeHostCommand(
            {
              command: formatExecCommand([descriptor.executable]),
              toolCallId,
              workdir: options.execSession?.execCwd,
              env: {},
              requestedNode: request.node,
              boundNode: defaults.node,
              agentId: options.agentId,
              sessionKey: options.agentSessionKey,
              sessionId: options.sessionId,
              security: defaults.security,
              ask: defaults.ask,
              bypassHostApprovalFloors:
                options.execSession?.permissionMode === "full" && defaults.security === "full",
              autoReview: defaults.mode === "auto",
              approvalReviewerDeviceId: options.approvalReviewerDeviceIds?.[0],
              turnSourceChannel: options.agentChannel,
              turnSourceTo: options.agentTo,
              turnSourceAccountId: options.agentAccountId,
              turnSourceThreadId: options.agentThreadId,
              defaultTimeoutSec: 30,
              approvalRunningNoticeMs: 1000,
              notifyOnExit: false,
              signal,
              warnings: [],
            },
            {
              argv: [descriptor.executable],
              installedApp: { appId: request.appId, appRevision: request.appRevision },
              invoke: async (call) => {
                const invocation = await invokeNodeSystemRun({
                  ...call,
                  requireAgentRuntimeIdentity: true,
                  invoke: {
                    ...call.invoke,
                    command: NODE_INSTALLED_APP_LAUNCH_COMMAND,
                    params: {
                      appId: request.appId,
                      appRevision: request.appRevision,
                      execution: asRecord(call.invoke.params),
                    },
                  },
                });
                if (invocation.ok) {
                  started = InstalledAppStartedSchema.parse(asRecord(invocation.raw).payload);
                }
                return invocation;
              },
              formatFollowup: (rawResult) =>
                JSON.stringify(InstalledAppStartedSchema.parse(asRecord(rawResult).payload)),
            },
          );
          return started ? jsonResult(started) : result;
        },
      ),
  );
}
