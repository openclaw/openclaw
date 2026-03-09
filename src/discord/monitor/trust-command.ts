import { Command, type CommandInteraction, type CommandOptions } from "@buape/carbon";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import { isDangerousNameMatchingEnabled } from "../../config/dangerous-name-matching.js";
import type { DiscordAccountConfig } from "../../config/types.js";
import { buildGatewayConnectionDetails } from "../../gateway/call.js";
import { GatewayClient } from "../../gateway/client.js";
import { logError } from "../../logger.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { allowListMatches, normalizeDiscordAllowList } from "./allow-list.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

type TrustCommandContext = {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
  ephemeralDefault: boolean;
  guildId?: string;
};

import {
  DEFAULT_MAX_TRUST_MINUTES,
  ABSOLUTE_MAX_TRUST_MINUTES,
} from "../../infra/exec-approvals.js";

function isOwnerAuthorized(
  interaction: CommandInteraction,
  discordConfig: DiscordAccountConfig,
): boolean {
  const user = interaction.user;
  if (!user) {
    return false;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const ownerAllowList = normalizeDiscordAllowList(
    discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
    ["discord:", "user:", "pk:"],
  );
  if (!ownerAllowList) {
    return false;
  }
  // Trust commands require explicit user ID match — wildcards ("*") are
  // intentionally rejected.  Granting unrestricted exec is a privileged
  // operation; only specifically-listed owner IDs may perform it.
  if (ownerAllowList.allowAll) {
    return false;
  }
  return allowListMatches(
    ownerAllowList,
    { id: sender.id, name: sender.name, tag: sender.tag },
    { allowNameMatching: isDangerousNameMatchingEnabled(discordConfig) },
  );
}

async function callGatewayRpc(
  cfg: OpenClawConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { url: gatewayUrl } = buildGatewayConnectionDetails({ config: cfg });
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new GatewayClient({
      url: gatewayUrl,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Discord Trust Command",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin"],
      onHelloOk: () => {
        client
          .request(method, params)
          .then((result) => {
            if (!settled) {
              settled = true;
              resolve(result);
            }
            client.stop();
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
            client.stop();
          });
      },
      onConnectError: (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
      onClose: () => {
        if (!settled) {
          settled = true;
          reject(new Error("Gateway connection closed"));
        }
      },
    });
    client.start();
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Gateway RPC timeout"));
      }
      client.stop();
    }, 10_000);
  });
}

class DiscordTrustCommand extends Command {
  name = "trust";
  description = "Grant a time-bounded trust window (unrestricted exec)";
  defer = true;
  ephemeral = true;
  guildId?: string;
  options: CommandOptions = [
    {
      name: "minutes",
      description: `Duration in minutes (default: ${DEFAULT_MAX_TRUST_MINUTES}, max: ${ABSOLUTE_MAX_TRUST_MINUTES} with force)`,
      type: ApplicationCommandOptionType.Number,
      required: false,
      min_value: 1,
      max_value: ABSOLUTE_MAX_TRUST_MINUTES,
    },
    {
      name: "force",
      description: `Allow exceeding default ${DEFAULT_MAX_TRUST_MINUTES}m cap (up to ${ABSOLUTE_MAX_TRUST_MINUTES}m)`,
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
    {
      name: "agent",
      description: "Agent id (default: main)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ];

  private ctx: TrustCommandContext;

  constructor(ctx: TrustCommandContext) {
    super();
    this.ephemeral = ctx.ephemeralDefault;
    if (ctx.guildId) {
      this.guildId = ctx.guildId;
    }
    this.ctx = ctx;
  }

  async run(interaction: CommandInteraction) {
    if (!isOwnerAuthorized(interaction, this.ctx.discordConfig)) {
      await interaction.reply({
        content: "⛔ You are not authorized to manage trust windows.",
        ephemeral: true,
      });
      return;
    }

    const minutes = interaction.options.getNumber("minutes") ?? DEFAULT_MAX_TRUST_MINUTES;
    const force = interaction.options.getBoolean("force") ?? false;
    const agentId = interaction.options.getString("agent")?.trim() || "main";

    try {
      const result = (await callGatewayRpc(this.ctx.cfg, "exec.approvals.trust", {
        agentId,
        minutes,
        force,
        grantedBy: `discord:${interaction.user?.id ?? "unknown"}`,
      })) as { ok: boolean; agentId: string; expiresAt?: number; message?: string };

      if (!result?.ok) {
        await interaction.reply({
          content: `❌ Failed to grant trust window: ${result?.message ?? "unknown error"}`,
          ephemeral: true,
        });
        return;
      }

      const expiresAtSec = result.expiresAt ? Math.floor(result.expiresAt / 1000) : null;
      const expiresLabel = expiresAtSec ? `<t:${expiresAtSec}:R>` : `in ${minutes}m`;

      await interaction.reply({
        content: `🔓 **Trust window active**\nAgent: ${agentId} · Duration: ${minutes}m · Expires ${expiresLabel}\nRun \`/untrust\` to revoke early.`,
        ephemeral: true,
      });
    } catch (err) {
      logError(`discord trust command: ${String(err)}`);
      await interaction.reply({
        content: `❌ Failed to grant trust window: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    }
  }
}

class DiscordUntrustCommand extends Command {
  name = "untrust";
  description = "Revoke an active trust window immediately";
  defer = true;
  ephemeral = true;
  guildId?: string;
  options: CommandOptions = [
    {
      name: "agent",
      description: "Agent id (default: main)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "keep_audit",
      description: "Preserve the audit log file (default: delete)",
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
  ];

  private ctx: TrustCommandContext;

  constructor(ctx: TrustCommandContext) {
    super();
    this.ephemeral = ctx.ephemeralDefault;
    if (ctx.guildId) {
      this.guildId = ctx.guildId;
    }
    this.ctx = ctx;
  }

  async run(interaction: CommandInteraction) {
    if (!isOwnerAuthorized(interaction, this.ctx.discordConfig)) {
      await interaction.reply({
        content: "⛔ You are not authorized to manage trust windows.",
        ephemeral: true,
      });
      return;
    }

    const agentId = interaction.options.getString("agent")?.trim() || "main";
    const keepAudit = interaction.options.getBoolean("keep_audit") ?? false;

    try {
      const result = (await callGatewayRpc(this.ctx.cfg, "exec.approvals.untrust", {
        agentId,
        keepAudit,
        revokedBy: `discord:${interaction.user?.id ?? "unknown"}`,
      })) as { ok: boolean; agentId: string; summary?: string };

      if (!result.ok) {
        await interaction.reply({
          content: `❌ Failed to revoke trust for agent "${agentId}": ${result.summary ?? "unknown error"}`,
          ephemeral: true,
        });
        return;
      }

      const summaryBlock = result.summary ? `\n\`\`\`\n${result.summary}\n\`\`\`` : "";
      const auditNote = keepAudit ? "\n📁 Audit log preserved." : "";

      await interaction.reply({
        content: `🔒 **Trust window revoked** for agent "${agentId}".${summaryBlock}${auditNote}`,
        ephemeral: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNoWindow = msg.includes("No active trust window");
      logError(`discord untrust command: ${msg}`);
      await interaction.reply({
        content: isNoWindow
          ? `ℹ️ No active trust window for agent "${agentId}".`
          : `❌ Failed to revoke trust: ${msg}`,
        ephemeral: true,
      });
    }
  }
}

export function createDiscordTrustCommand(ctx: TrustCommandContext): Command {
  return new DiscordTrustCommand(ctx);
}

export function createDiscordUntrustCommand(ctx: TrustCommandContext): Command {
  return new DiscordUntrustCommand(ctx);
}
