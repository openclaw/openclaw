import {
  Button,
  Row,
  Separator,
  TextDisplay,
  serializePayload,
  type ButtonInteraction,
  type ComponentData,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "@buape/carbon";
import { ButtonStyle, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordExecApprovalConfig } from "../../config/types.discord.js";
import type { EventFrame } from "../../gateway/protocol/index.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "../../infra/exec-approvals.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { buildGatewayConnectionDetails } from "../../gateway/call.js";
import { GatewayClient } from "../../gateway/client.js";
import { logDebug, logError } from "../../logger.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { createDiscordClient, stripUndefinedFields } from "../send.shared.js";
import { DiscordUiContainer } from "../ui.js";

const EXEC_APPROVAL_KEY = "execapproval";

export type { ExecApprovalRequest, ExecApprovalResolved };

/** Extract Discord channel ID from a session key like "agent:main:discord:channel:123456789" */
export function extractDiscordChannelId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  // Session key format: agent:<id>:discord:channel:<channelId> or agent:<id>:discord:group:<channelId>
  const match = sessionKey.match(/discord:(?:channel|group):(\d+)/);
  return match ? match[1] : null;
}

type PendingApproval = {
  discordMessageId: string;
  discordChannelId: string;
  timeoutId: NodeJS.Timeout;
};

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildExecApprovalCustomId(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  return [`${EXEC_APPROVAL_KEY}:id=${encodeCustomIdValue(approvalId)}`, `action=${action}`].join(
    ";",
  );
}

export function parseExecApprovalData(
  data: ComponentData,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawId = coerce(data.id);
  const rawAction = coerce(data.action);
  if (!rawId || !rawAction) {
    return null;
  }
  const action = rawAction as ExecApprovalDecision;
  if (action !== "allow-once" && action !== "allow-always" && action !== "deny") {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawId),
    action,
  };
}

type ExecApprovalContainerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  title: string;
  description?: string;
  commandPreview: string;
  metadataLines?: string[];
  actionRow?: Row<Button>;
  footer?: string;
  accentColor?: string;
};

class ExecApprovalContainer extends DiscordUiContainer {
  constructor(params: ExecApprovalContainerParams) {
    const components: Array<TextDisplay | Separator | Row<Button>> = [
      new TextDisplay(`## ${params.title}`),
    ];
    if (params.description) {
      components.push(new TextDisplay(params.description));
    }
    components.push(new Separator({ divider: true, spacing: "small" }));
    components.push(new TextDisplay(`### Command\n\`\`\`\n${params.commandPreview}\n\`\`\``));
    if (params.metadataLines?.length) {
      components.push(new TextDisplay(params.metadataLines.join("\n")));
    }
    if (params.actionRow) {
      components.push(params.actionRow);
    }
    if (params.footer) {
      components.push(new Separator({ divider: false, spacing: "small" }));
      components.push(new TextDisplay(`-# ${params.footer}`));
    }
    super({
      cfg: params.cfg,
      accountId: params.accountId,
      components,
      accentColor: params.accentColor,
    });
  }
}

class ExecApprovalActionButton extends Button {
  customId: string;
  label: string;
  style: ButtonStyle;

  constructor(params: {
    approvalId: string;
    action: ExecApprovalDecision;
    label: string;
    style: ButtonStyle;
  }) {
    super();
    this.customId = buildExecApprovalCustomId(params.approvalId, params.action);
    this.label = params.label;
    this.style = params.style;
  }
}

class ExecApprovalActionRow extends Row<Button> {
  constructor(approvalId: string) {
    super([
      new ExecApprovalActionButton({
        approvalId,
        action: "allow-once",
        label: "Allow once",
        style: ButtonStyle.Success,
      }),
      new ExecApprovalActionButton({
        approvalId,
        action: "allow-always",
        label: "Always allow",
        style: ButtonStyle.Primary,
      }),
      new ExecApprovalActionButton({
        approvalId,
        action: "deny",
        label: "Deny",
        style: ButtonStyle.Danger,
      }),
    ]);
  }
}

function resolveExecApprovalAccountId(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): string | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const channel = normalizeMessageChannel(entry?.origin?.provider ?? entry?.lastChannel);
    if (channel && channel !== "discord") {
      return null;
    }
    const accountId = entry?.origin?.accountId ?? entry?.lastAccountId;
    return accountId?.trim() || null;
  } catch {
    return null;
  }
}

function buildExecApprovalMetadataLines(request: ExecApprovalRequest): string[] {
  const lines: string[] = [];
  if (request.request.cwd) {
    lines.push(`- Working Directory: ${request.request.cwd}`);
  }
  if (request.request.host) {
    lines.push(`- Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`- Agent: ${request.request.agentId}`);
  }
  return lines;
}

function buildExecApprovalPayload(container: DiscordUiContainer): MessagePayloadObject {
  const components: TopLevelComponents[] = [container];
  return { components };
}

function createExecApprovalRequestContainer(params: {
  request: ExecApprovalRequest;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const commandText = params.request.request.command;
  const commandPreview =
    commandText.length > 1000 ? `${commandText.slice(0, 1000)}...` : commandText;
  const expiresAtSeconds = Math.max(0, Math.floor(params.request.expiresAtMs / 1000));

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    commandPreview,
    metadataLines: buildExecApprovalMetadataLines(params.request),
    actionRow: params.actionRow,
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.request.id}`,
    accentColor: "#FFA500",
  });
}

function createResolvedContainer(params: {
  request: ExecApprovalRequest;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const commandText = params.request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;

  const decisionLabel =
    params.decision === "allow-once"
      ? "Allowed (once)"
      : params.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";

  const accentColor =
    params.decision === "deny"
      ? "#ED4245"
      : params.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: `Exec Approval: ${decisionLabel}`,
    description: params.resolvedBy ? `Resolved by ${params.resolvedBy}` : "Resolved",
    commandPreview,
    footer: `ID: ${params.request.id}`,
    accentColor,
  });
}

function createExpiredContainer(params: {
  request: ExecApprovalRequest;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const commandText = params.request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Exec Approval: Expired",
    description: "This approval request has expired.",
    commandPreview,
    footer: `ID: ${params.request.id}`,
    accentColor: "#99AAB5",
  });
}

export type DiscordExecApprovalHandlerOpts = {
  token: string;
  accountId: string;
  config: DiscordExecApprovalConfig;
  gatewayUrl?: string;
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  onResolve?: (id: string, decision: ExecApprovalDecision) => Promise<void>;
};

export class DiscordExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private requestCache = new Map<string, ExecApprovalRequest>();
  private opts: DiscordExecApprovalHandlerOpts;
  private started = false;

  constructor(opts: DiscordExecApprovalHandlerOpts) {
    this.opts = opts;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) {
      return false;
    }
    if (!config.approvers || config.approvers.length === 0) {
      return false;
    }

    const requestAccountId = resolveExecApprovalAccountId({
      cfg: this.opts.cfg,
      request,
    });
    if (requestAccountId) {
      const handlerAccountId = normalizeAccountId(this.opts.accountId);
      if (normalizeAccountId(requestAccountId) !== handlerAccountId) {
        return false;
      }
    }

    // Check agent filter
    if (config.agentFilter?.length) {
      if (!request.request.agentId) {
        return false;
      }
      if (!config.agentFilter.includes(request.request.agentId)) {
        return false;
      }
    }

    // Check session filter (substring match)
    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) {
        return false;
      }
      const matches = config.sessionFilter.some((p) => {
        try {
          return session.includes(p) || new RegExp(p).test(session);
        } catch {
          return session.includes(p);
        }
      });
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const config = this.opts.config;
    if (!config.enabled) {
      logDebug("discord exec approvals: disabled");
      return;
    }

    if (!config.approvers || config.approvers.length === 0) {
      logDebug("discord exec approvals: no approvers configured");
      return;
    }

    logDebug("discord exec approvals: starting handler");

    const { url: gatewayUrl } = buildGatewayConnectionDetails({
      config: this.opts.cfg,
      url: this.opts.gatewayUrl,
    });

    this.gatewayClient = new GatewayClient({
      url: gatewayUrl,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Discord Exec Approvals",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onHelloOk: () => {
        logDebug("discord exec approvals: connected to gateway");
      },
      onConnectError: (err) => {
        logError(`discord exec approvals: connect error: ${err.message}`);
      },
      onClose: (code, reason) => {
        logDebug(`discord exec approvals: gateway closed: ${code} ${reason}`);
      },
    });

    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    // Clear all pending timeouts
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.requestCache.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("discord exec approvals: stopped");
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      const request = evt.payload as ExecApprovalRequest;
      void this.handleApprovalRequested(request);
    } else if (evt.event === "exec.approval.resolved") {
      const resolved = evt.payload as ExecApprovalResolved;
      void this.handleApprovalResolved(resolved);
    }
  }

  private async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) {
      return;
    }

    logDebug(`discord exec approvals: received request ${request.id}`);

    this.requestCache.set(request.id, request);

    const { rest, request: discordRequest } = createDiscordClient(
      { token: this.opts.token, accountId: this.opts.accountId },
      this.opts.cfg,
    );

    const actionRow = new ExecApprovalActionRow(request.id);
    const container = createExecApprovalRequestContainer({
      request,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      actionRow,
    });
    const payload = buildExecApprovalPayload(container);
    const body = stripUndefinedFields(serializePayload(payload));

    const target = this.opts.config.target ?? "dm";
    const sendToDm = target === "dm" || target === "both";
    const sendToChannel = target === "channel" || target === "both";
    let fallbackToDm = false;

    // Send to originating channel if configured
    if (sendToChannel) {
      const channelId = extractDiscordChannelId(request.request.sessionKey);
      if (channelId) {
        try {
          const message = (await discordRequest(
            () =>
              rest.post(Routes.channelMessages(channelId), {
                body,
              }) as Promise<{ id: string; channel_id: string }>,
            "send-approval-channel",
          )) as { id: string; channel_id: string };

          if (message?.id) {
            const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
            const timeoutId = setTimeout(() => {
              void this.handleApprovalTimeout(request.id, "channel");
            }, timeoutMs);

            this.pending.set(`${request.id}:channel`, {
              discordMessageId: message.id,
              discordChannelId: channelId,
              timeoutId,
            });

            logDebug(`discord exec approvals: sent approval ${request.id} to channel ${channelId}`);
          }
        } catch (err) {
          logError(`discord exec approvals: failed to send to channel: ${String(err)}`);
        }
      } else {
        if (!sendToDm) {
          logError(
            `discord exec approvals: target is "channel" but could not extract channel id from session key "${request.request.sessionKey ?? "(none)"}" — falling back to DM delivery for approval ${request.id}`,
          );
          fallbackToDm = true;
        } else {
          logDebug("discord exec approvals: could not extract channel id from session key");
        }
      }
    }

    // Send to approver DMs if configured (or as fallback when channel extraction fails)
    if (sendToDm || fallbackToDm) {
      const approvers = this.opts.config.approvers ?? [];

      for (const approver of approvers) {
        const userId = String(approver);
        try {
          // Create DM channel
          const dmChannel = (await discordRequest(
            () =>
              rest.post(Routes.userChannels(), {
                body: { recipient_id: userId },
              }) as Promise<{ id: string }>,
            "dm-channel",
          )) as { id: string };

          if (!dmChannel?.id) {
            logError(`discord exec approvals: failed to create DM for user ${userId}`);
            continue;
          }

          // Send message with components v2 + buttons
          const message = (await discordRequest(
            () =>
              rest.post(Routes.channelMessages(dmChannel.id), {
                body,
              }) as Promise<{ id: string; channel_id: string }>,
            "send-approval",
          )) as { id: string; channel_id: string };

          if (!message?.id) {
            logError(`discord exec approvals: failed to send message to user ${userId}`);
            continue;
          }

          // Clear any existing pending DM entry to avoid timeout leaks
          const existingDm = this.pending.get(`${request.id}:dm`);
          if (existingDm) {
            clearTimeout(existingDm.timeoutId);
          }

          // Set up timeout
          const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
          const timeoutId = setTimeout(() => {
            void this.handleApprovalTimeout(request.id, "dm");
          }, timeoutMs);

          this.pending.set(`${request.id}:dm`, {
            discordMessageId: message.id,
            discordChannelId: dmChannel.id,
            timeoutId,
          });

          logDebug(`discord exec approvals: sent approval ${request.id} to user ${userId}`);
        } catch (err) {
          logError(`discord exec approvals: failed to notify user ${userId}: ${String(err)}`);
        }
      }
    }
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    // Clean up all pending entries for this approval (channel + dm)
    const request = this.requestCache.get(resolved.id);
    this.requestCache.delete(resolved.id);

    if (!request) {
      return;
    }

    logDebug(`discord exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    const container = createResolvedContainer({
      request,
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
    });

    for (const suffix of [":channel", ":dm", ""]) {
      const key = `${resolved.id}${suffix}`;
      const pending = this.pending.get(key);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timeoutId);
      this.pending.delete(key);

      await this.finalizeMessage(pending.discordChannelId, pending.discordMessageId, container);
    }
  }

  private async handleApprovalTimeout(
    approvalId: string,
    source?: "channel" | "dm",
  ): Promise<void> {
    const key = source ? `${approvalId}:${source}` : approvalId;
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    this.pending.delete(key);

    const request = this.requestCache.get(approvalId);

    // Only clean up requestCache if no other pending entries exist for this approval
    const hasOtherPending =
      this.pending.has(`${approvalId}:channel`) ||
      this.pending.has(`${approvalId}:dm`) ||
      this.pending.has(approvalId);
    if (!hasOtherPending) {
      this.requestCache.delete(approvalId);
    }

    if (!request) {
      return;
    }

    logDebug(`discord exec approvals: timeout for ${approvalId} (${source ?? "default"})`);

    const container = createExpiredContainer({
      request,
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
    });
    await this.finalizeMessage(pending.discordChannelId, pending.discordMessageId, container);
  }

  private async finalizeMessage(
    channelId: string,
    messageId: string,
    container: DiscordUiContainer,
  ): Promise<void> {
    if (!this.opts.config.cleanupAfterResolve) {
      await this.updateMessage(channelId, messageId, container);
      return;
    }

    try {
      const { rest, request: discordRequest } = createDiscordClient(
        { token: this.opts.token, accountId: this.opts.accountId },
        this.opts.cfg,
      );

      await discordRequest(
        () => rest.delete(Routes.channelMessage(channelId, messageId)) as Promise<void>,
        "delete-approval",
      );
    } catch (err) {
      logError(`discord exec approvals: failed to delete message: ${String(err)}`);
      await this.updateMessage(channelId, messageId, container);
    }
  }

  private async updateMessage(
    channelId: string,
    messageId: string,
    container: DiscordUiContainer,
  ): Promise<void> {
    try {
      const { rest, request: discordRequest } = createDiscordClient(
        { token: this.opts.token, accountId: this.opts.accountId },
        this.opts.cfg,
      );
      const payload = buildExecApprovalPayload(container);

      await discordRequest(
        () =>
          rest.patch(Routes.channelMessage(channelId, messageId), {
            body: stripUndefinedFields(serializePayload(payload)),
          }),
        "update-approval",
      );
    } catch (err) {
      logError(`discord exec approvals: failed to update message: ${String(err)}`);
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    if (!this.gatewayClient) {
      logError("discord exec approvals: gateway client not connected");
      return false;
    }

    logDebug(`discord exec approvals: resolving ${approvalId} with ${decision}`);

    try {
      await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      logDebug(`discord exec approvals: resolved ${approvalId} successfully`);
      return true;
    } catch (err) {
      logError(`discord exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }

  /** Return the list of configured approver IDs. */
  getApprovers(): string[] {
    return this.opts.config.approvers ?? [];
  }
}

export type ExecApprovalButtonContext = {
  handler: DiscordExecApprovalHandler;
};

export class ExecApprovalButton extends Button {
  label = "execapproval";
  customId = `${EXEC_APPROVAL_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: ExecApprovalButtonContext;

  constructor(ctx: ExecApprovalButtonContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseExecApprovalData(data);
    if (!parsed) {
      try {
        await interaction.update({
          content: "This approval is no longer valid.",
          components: [],
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    // Verify the user is an authorized approver
    const approvers = this.ctx.handler.getApprovers();
    const userId = interaction.userId;
    if (!approvers.some((id) => String(id) === userId)) {
      try {
        await interaction.reply({
          content: "⛔ You are not authorized to approve exec requests.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const decisionLabel =
      parsed.action === "allow-once"
        ? "Allowed (once)"
        : parsed.action === "allow-always"
          ? "Allowed (always)"
          : "Denied";

    // Update the message immediately to show the decision
    try {
      await interaction.update({
        content: `Submitting decision: **${decisionLabel}**...`,
        components: [], // Remove buttons
      });
    } catch {
      // Interaction may have expired, try to continue anyway
    }

    const ok = await this.ctx.handler.resolveApproval(parsed.approvalId, parsed.action);

    if (!ok) {
      try {
        await interaction.followUp({
          content:
            "Failed to submit approval decision. The request may have expired or already been resolved.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
    // On success, the handleApprovalResolved event will update the message with the final result
  }
}

export function createExecApprovalButton(ctx: ExecApprovalButtonContext): Button {
  return new ExecApprovalButton(ctx);
}
