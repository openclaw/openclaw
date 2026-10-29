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
      ? "Gateway restart, config, channels, plugins, agents, models/providers: ask `openclaw`."
      : hasGateway
        ? `Config read: \`gateway\` (\`config.get|config.schema.lookup\`) only when those actions are exposed by its schema. Config writes and restarts need the \`openclaw\` tool${restartCommandsEnabled ? "; the owner can send `/restart` in chat." : "."}`
        : "",
    [
      "For the Gateway hosting this session:",
      ...(restartCommandsEnabled
        ? [
            "In a connected chat, the owner can send `/update` with commands.restart enabled (the default), regardless of the agent's tool profile.",
          ]
        : []),
      hasGateway
        ? "Update OpenClaw: `gateway` action update.run, only on an explicit owner request or an operator-scheduled update; the runtime coordinates restart and completion notices. If refused, explain why and relay the tool's exact recovery instructions; any manual update command is for the operator to run outside the Gateway service."
        : restartCommandsEnabled
          ? "For a chat update request, direct the user to `/update`. Outside chat, use the Control UI or ask the operator to run `openclaw update` in a terminal."
          : "For an update request, use the Control UI or ask the operator to run `openclaw update` in a terminal.",
      "Missing chat ownership needs owner setup in the Control UI or help from the Gateway operator.",
      "Never run openclaw update, npm install -g openclaw, swap installations, or stop/restart the gateway service via exec or detached jobs.",
    ].join(" "),
    hasExec
      ? "For a user-requested update on another host, verify it is not this Gateway, then use exec/SSH with `openclaw update --yes`; normal exec approvals still apply."
      : "",
    "",
  ];
}
