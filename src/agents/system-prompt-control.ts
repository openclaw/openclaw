/** Renders operator control guidance from the configured command and tool capabilities. */
export function buildOpenClawControlSection({
  hasOpenClaw,
  hasGateway,
  hasExec,
  restartCommandsEnabled,
}: {
  hasOpenClaw: boolean;
  hasGateway: boolean;
  hasExec: boolean;
  restartCommandsEnabled: boolean;
}): string[] {
  return [
    "## OpenClaw Control",
    "Do not invent commands.",
    hasOpenClaw
      ? hasGateway
        ? "Config writes, channels, plugins, agents, models/providers: ask `openclaw`."
        : "Gateway restart, config, channels, plugins, agents, models/providers: ask `openclaw`."
      : hasGateway
        ? `Config read: \`gateway\` (\`config.get|config.schema.lookup\`) only when those actions are exposed by its schema. Config writes need the \`openclaw\` tool.`
        : "",
    [
      "For the Gateway hosting this session:",
      ...(restartCommandsEnabled
        ? [
            "In a connected chat, the owner can send `/update` with commands.restart enabled (the default), regardless of the agent's tool profile.",
          ]
        : []),
      hasGateway
        ? "On an explicit owner request or operator-scheduled maintenance, perform the work with `gateway`: update.run updates with supervised restart and completion notices; restart schedules a safe restart; update.cleanup retires eligible recovery copies while the Gateway keeps running (dryRun previews). Cleanup permanently removes eligible rollback copies, so require a cleanup request, not merely an update request. Do not redirect the owner to slash commands or a terminal when these actions are available. Report accepted or deferred work accurately; scheduling is not completion."
        : restartCommandsEnabled
          ? "For a chat update request, direct the user to `/update`. Outside chat, use the Control UI or ask the operator to run `openclaw update` in a terminal."
          : "For an update request, use the Control UI or ask the operator to run `openclaw update` in a terminal.",
      "Missing chat ownership needs owner setup in the Control UI or help from the Gateway operator.",
      "Use runtime-supervised maintenance: the Gateway must retain a working restart path before it stops. For this Gateway, use maintenance tools, not exec or detached jobs, for installation changes or service control. If runtime admission refuses, report the concrete blocker; do not bypass owner/operator authorization.",
    ].join(" "),
    hasExec
      ? "For a user-requested update on another host, verify it is not this Gateway, then use exec/SSH with `openclaw update --yes`; normal exec approvals still apply."
      : "",
    "",
  ];
}
