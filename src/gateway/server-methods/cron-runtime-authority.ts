import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../cron-creator-authority-grant.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import { respondInvalidCronParams } from "./cron-job-access.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

const AUTHORITY_GUARDED_READS = new Set(["cron.list", "cron.get", "cron.runs", "cron.history"]);

// The existing one-use grant is request-scoped; the original runtime identity
// stays intact so deferred cron commits still fence the exact admitted run.
export function wrapCronHandlersWithRuntimeAuthority(handlers: GatewayRequestHandlers): void {
  for (const [method, handler] of Object.entries(handlers)) {
    const wrapped: GatewayRequestHandler = async (args) => {
      const identity = args.client?.internal?.agentRuntimeIdentity;
      if (!identity) {
        return await handler(args);
      }
      const grant = identity.cronManagementGrant;
      let succeeded = false;
      const run = async () => {
        assertActiveAgentRuntimeAuthority(args.client, args.context);
        await handler({
          ...args,
          respond: (...response) => {
            // Reads release data here; mutations already checked at commit. A late
            // acknowledgement must not turn a committed effect into a retryable denial.
            if (AUTHORITY_GUARDED_READS.has(method)) {
              assertActiveAgentRuntimeAuthority(args.client, args.context);
              getCronManagementAuthority(identity)?.();
            }
            succeeded = response[0];
            args.respond(...response);
          },
        });
      };
      try {
        await (grant ? withCronManagementGrant(grant, identity, method, run) : run());
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
        respondInvalidCronParams(args.respond, method, error.message);
      } finally {
        if (grant) {
          args.context.logGateway.info("cron: admin management", {
            method,
            runId: identity.operationalRunInstance.runId,
            instanceId: identity.operationalRunInstance.instanceId,
            ok: succeeded,
          });
        }
      }
    };
    if (handler.prepareRead) {
      const prepareRead = handler.prepareRead;
      wrapped.prepareRead = (args) =>
        args.client?.internal?.agentRuntimeIdentity
          ? { run: (respond) => wrapped({ ...args, respond }) }
          : prepareRead(args);
    }
    handlers[method] = wrapped;
  }
}
