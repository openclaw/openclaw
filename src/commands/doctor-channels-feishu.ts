import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

interface FeishuDiagnosticResult {
  enabled: boolean;
  accountsConfigured: number;
  groupsConfigured: number;
  issues: string[];
  warnings: string[];
  tips: string[];
}

/**
 * Diagnose Feishu channel configuration
 * Focuses on group policy validation and common misconfigurations
 */
export async function diagnoseFeishuChannel(cfg: OpenClawConfig): Promise<FeishuDiagnosticResult> {
  const result: FeishuDiagnosticResult = {
    enabled: false,
    accountsConfigured: 0,
    groupsConfigured: 0,
    issues: [],
    warnings: [],
    tips: [],
  };

  const feishuCfg = cfg.channels?.feishu;
  if (!feishuCfg) {
    result.issues.push("- Feishu channel not configured in openclaw.json");
    return result;
  }

  // Check if Feishu is enabled
  if (feishuCfg.enabled === false) {
    result.issues.push("- Feishu channel is disabled (channels.feishu.enabled = false)");
    return result;
  }

  result.enabled = true;

  // Check accounts configuration
  const accounts = feishuCfg.accounts ?? {};
  const accountIds = Object.keys(accounts);
  result.accountsConfigured = accountIds.length;

  if (accountIds.length === 0) {
    result.issues.push("- No Feishu accounts configured (channels.feishu.accounts is empty)");
    return result;
  }

  // Check each account for required fields
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountId === "default") {
      continue;
    } // Skip default account

    const hasAppId = !!(account as Record<string, unknown>).appId?.toString().trim();
    const hasAppSecret = !!(account as Record<string, unknown>).appSecret?.toString().trim();

    if (!hasAppId || !hasAppSecret) {
      result.issues.push(
        `- Account '${accountId}': Missing AppID or AppSecret`,
        `  Fix: Run ${formatCliCommand(`openclaw configure`)} to set up Feishu credentials`,
      );
    }
  }

  // Check group policy configuration
  const defaultAccount = accounts.default;
  const groupPolicy = defaultAccount?.groupPolicy ?? feishuCfg.groupPolicy ?? "open";
  const groupAllowFrom = defaultAccount?.groupAllowFrom ?? feishuCfg.groupAllowFrom;

  // Check groups configuration
  const groups = feishuCfg.groups ?? {};
  result.groupsConfigured = Object.keys(groups).length;

  // Validate group policy configuration
  if (groupPolicy === "allowlist") {
    if (!groupAllowFrom || groupAllowFrom.length === 0) {
      result.issues.push(
        `- Group policy is "allowlist" but groupAllowFrom is not configured`,
        `  This will block ALL group messages!`,
        `  Fix: Add group IDs to channels.feishu.groupAllowFrom`,
        `  Example: ${formatCliCommand(
          'openclaw config set channels.feishu.groupAllowFrom \'["oc_xxx","oc_yyy"]\'',
        )}`,
      );
    } else {
      result.tips.push(`✓ Group allowlist configured with ${groupAllowFrom.length} group(s)`);
    }
  } else if (groupPolicy === "open") {
    result.warnings.push(
      `- Group policy is "open" - all group members can trigger the bot`,
      `  Consider using "allowlist" mode for better access control`,
      `  Docs: https://docs.openclaw.ai/channels/feishu`,
    );
  } else if (groupPolicy === "disabled") {
    result.warnings.push(`- Group messages are disabled (groupPolicy = "disabled")`);
  }

  // Check individual group configurations
  for (const [groupId, groupConfig] of Object.entries(groups)) {
    const allowList =
      ((groupConfig as Record<string, unknown>).allow as string[] | undefined) ?? [];
    const requireMention =
      ((groupConfig as Record<string, unknown>).requireMention as boolean | undefined) ?? false;

    if (allowList.length === 0) {
      result.warnings.push(
        `- Group ${groupId}: No allow list configured`,
        `  With groupPolicy="open", all members can trigger (mention-gated if requireMention=true)`,
      );
    }

    if (requireMention) {
      result.tips.push(`✓ Group ${groupId}: Mention required for bot responses`);
    }
  }

  // Check for common misconfigurations we've seen before
  // (based on real issue: MEMORY.md 飞书群组消息接收问题排查与修复经验)
  if (groupPolicy === "allowlist" && groupAllowFrom && groupAllowFrom.length > 0) {
    // Check if any configured groups are NOT in groupAllowFrom
    const configuredGroupIds = Object.keys(groups);
    const missingFromAllowFrom = configuredGroupIds.filter((gid) => !groupAllowFrom.includes(gid));

    if (missingFromAllowFrom.length > 0) {
      result.warnings.push(
        `- ${missingFromAllowFrom.length} configured group(s) not in groupAllowFrom:`,
        `  ${missingFromAllowFrom.join(", ")}`,
        `  These groups will NOT receive bot messages!`,
        `  Fix: Add to groupAllowFrom or set groupPolicy="open"`,
      );
    }
  }

  // Check connection mode
  const connectionMode = feishuCfg.connectionMode ?? "websocket";
  if (connectionMode === "webhook") {
    result.tips.push(`✓ Using webhook mode for Feishu connection`);
    result.warnings.push(`- Webhook mode requires proper webhook URL configuration in Feishu app`);
  } else {
    result.tips.push(`✓ Using WebSocket mode for Feishu connection`);
  }

  return result;
}

/**
 * Display Feishu channel diagnostic results
 */
export async function noteFeishuChannelDiagnostic(cfg: OpenClawConfig) {
  const result = await diagnoseFeishuChannel(cfg);

  if (!result.enabled) {
    note(result.issues.join("\n"), "Feishu Channel");
    return;
  }

  const sections: string[] = [];

  // Status section
  sections.push(`Enabled: ✓`);
  sections.push(`Accounts: ${result.accountsConfigured}`);
  sections.push(`Groups: ${result.groupsConfigured}`);

  // Issues section
  if (result.issues.length > 0) {
    sections.push(`\n❌ Issues:`);
    sections.push(...result.issues);
  }

  // Warnings section
  if (result.warnings.length > 0) {
    sections.push(`\n⚠️  Warnings:`);
    sections.push(...result.warnings);
  }

  // Tips section
  if (result.tips.length > 0) {
    sections.push(`\n✓ Tips:`);
    sections.push(...result.tips);
  }

  // Add diagnostic command hint
  sections.push(`\n🔍 Detailed check: ${formatCliCommand("openclaw doctor channels feishu")}`);

  note(sections.join("\n"), "Feishu Channel");
}
