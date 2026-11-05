import { authorizeSessionAgentRun } from "./session-sharing-policy.js";

/** Presentation and file reads consume the same host-workspace admission policy. */
export function authorizeSessionWorkspaceRead(
  params: Parameters<typeof authorizeSessionAgentRun>[0] & {
    unscopedHostRoot: boolean;
  },
  prepared?: Parameters<typeof authorizeSessionAgentRun>[1],
) {
  return params.unscopedHostRoot
    ? authorizeSessionAgentRun(
        {
          ...params,
          sandboxRequiredMessage:
            "Your operator role requires a sandboxed session. You cannot read this session's host workspace files. Ask the owner to download and share the file, then attach it to your own session.",
        },
        prepared,
      )
    : null;
}
