import { resolveScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import {
  resolveCronAuthenticatedCallerOrigin,
  resolveCronAuthenticatedChannelRequester,
} from "./tools-allow-provenance.js";
import type { CronStoredJob } from "./types.js";

/** Projects runtime policy from recorded authority without rewriting capture provenance. */
export function resolveCronJobToolPolicyContext(
  job: CronStoredJob,
  toolsAllow: string[] | undefined,
) {
  const recordedOrigin = resolveCronAuthenticatedCallerOrigin(job);
  const requester = resolveCronAuthenticatedChannelRequester(job);
  return resolveScheduledToolPolicyContext({
    toolsAllow,
    scheduledToolPolicy: resolveCronScheduledToolPolicy({
      toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    }),
    // Requester-only captures already authenticate this channel and account. Session
    // names and delivery routes are not authority; missing requester facts stay unknown.
    callerOrigin:
      recordedOrigin ?? (requester ? { kind: "external", channel: requester.channel } : undefined),
    execTarget: job.toolsAllowExecTarget,
  });
}
