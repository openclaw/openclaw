/** The node-local command surface owns both advertised commands and their capabilities. */
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import { NODE_CLAUDE_SKILLS_CAPABILITY } from "../infra/node-claude-skill-protocol.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DEVICE_APPS_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_TERMINAL_UPLOAD_COMMAND,
} from "../infra/node-commands.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";

export const preferMacAppExecHost =
  process.platform === "darwin" &&
  process.env.OPENCLAW_NODE_EXEC_HOST?.trim().toLowerCase() === "app";

export type NodeHostManifest = ReturnType<typeof buildNodeHostManifest>;

export function buildNodeHostManifest(params: {
  pluginManifest: ReturnType<typeof listRegisteredNodeHostCapsAndCommands>;
  commandAllowlist?: ReadonlySet<string>;
  claudeEnabled: boolean;
  installedAppsSharingEnabled: boolean;
  desktopStreamingEnabled: boolean;
  ephemeral: boolean;
  pathEnv: string;
}) {
  const { pluginManifest, commandAllowlist } = params;
  const builtins: Array<[string, readonly string[]]> = [
    [SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY, preferMacAppExecHost ? [] : ["system.run"]],
    [
      "system",
      [
        ...NODE_SYSTEM_RUN_COMMANDS,
        ...NODE_EXEC_APPROVALS_COMMANDS,
        NODE_FS_LIST_DIR_COMMAND,
        NODE_TERMINAL_UPLOAD_COMMAND,
      ],
    ],
    ["mcp", [NODE_MCP_TOOLS_CALL_COMMAND]],
    ["device", params.installedAppsSharingEnabled ? [NODE_DEVICE_APPS_COMMAND] : []],
    [
      NODE_CLAUDE_SKILLS_CAPABILITY,
      params.claudeEnabled ? [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND] : [],
    ],
    ["screen", params.desktopStreamingEnabled ? [NODE_DESKTOP_STREAM_COMMAND] : []],
  ];
  const commands = [
    ...new Set([
      ...builtins.flatMap(([, ids]) => ids),
      ...pluginManifest.commands.filter(
        (command) =>
          !params.ephemeral || (command !== "screen.snapshot" && command !== "computer.act"),
      ),
    ]),
  ]
    .filter((command) => !commandAllowlist || commandAllowlist.has(command))
    .toSorted();
  // Plugin capabilities are already filtered at their registry owner, where the
  // command-to-capability relation is authoritative.
  const caps = [
    ...new Set([
      ...builtins
        .filter(([cap, ids]) =>
          commandAllowlist
            ? ids.some((id) => commands.includes(id))
            : cap !== "screen" && ids.length > 0,
        )
        .map(([cap]) => cap),
      ...pluginManifest.caps.filter(
        (cap) => !params.ephemeral || (cap !== "computer" && cap !== "screen"),
      ),
    ]),
  ].toSorted();
  return {
    caps,
    commands,
    ...(!commandAllowlist && !params.ephemeral && pluginManifest.computerUse
      ? { computerUse: pluginManifest.computerUse }
      : {}),
    ...(!commandAllowlist ? { pathEnv: params.pathEnv } : {}),
  };
}

export type NodeHostInventory = ReturnType<typeof createNodeHostInventory>;

export function createNodeHostInventory(
  skills: unknown[] | null,
  pluginTools: readonly NodePluginToolDescriptor[],
  mcpDescriptors: readonly NodePluginToolDescriptor[] = [],
) {
  const sortedPluginTools = [...pluginTools, ...mcpDescriptors].toSorted((left, right) => {
    return left.pluginId.localeCompare(right.pluginId) || left.name.localeCompare(right.name);
  });
  return { skills, pluginTools: sortedPluginTools };
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameNodeHostManifest(left: NodeHostManifest, right: NodeHostManifest): boolean {
  return (
    left.pathEnv === right.pathEnv &&
    sameStringList(left.caps, right.caps) &&
    sameStringList(left.commands, right.commands) &&
    JSON.stringify(left.computerUse) === JSON.stringify(right.computerUse)
  );
}
