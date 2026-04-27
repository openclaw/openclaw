import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelSetupPlugin } from "../channels/plugins/setup-registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { formatDocsLink } from "../terminal/links.js";
export function formatAccountLabel(accountId) {
    return accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId;
}
export async function promptConfiguredAction(params) {
    const { prompter, label, supportsDisable, supportsDelete } = params;
    const options = [
        {
            value: "update",
            label: "Modify settings",
        },
        ...(supportsDisable
            ? [
                {
                    value: "disable",
                    label: "Disable (keeps config)",
                },
            ]
            : []),
        ...(supportsDelete
            ? [
                {
                    value: "delete",
                    label: "Delete config",
                },
            ]
            : []),
        {
            value: "skip",
            label: "Skip (leave as-is)",
        },
    ];
    return await prompter.select({
        message: `${label} already configured. What do you want to do?`,
        options,
        initialValue: "update",
    });
}
export async function promptRemovalAccountId(params) {
    const { cfg, prompter, label, channel } = params;
    const plugin = params.plugin ?? getChannelSetupPlugin(channel);
    if (!plugin) {
        return DEFAULT_ACCOUNT_ID;
    }
    const accountIds = plugin.config.listAccountIds(cfg).filter(Boolean);
    const defaultAccountId = resolveChannelDefaultAccountId({ plugin, cfg, accountIds });
    if (accountIds.length <= 1) {
        return defaultAccountId;
    }
    const selected = await prompter.select({
        message: `${label} account`,
        options: accountIds.map((accountId) => ({
            value: accountId,
            label: formatAccountLabel(accountId),
        })),
        initialValue: defaultAccountId,
    });
    return normalizeAccountId(selected) ?? defaultAccountId;
}
export async function maybeConfigureDmPolicies(params) {
    const { selection, prompter, accountIdsByChannel } = params;
    const resolve = params.resolveAdapter ?? (() => undefined);
    const dmPolicies = selection
        .map((channel) => resolve(channel)?.dmPolicy)
        .filter(Boolean);
    if (dmPolicies.length === 0) {
        return params.cfg;
    }
    const wants = await prompter.confirm({
        message: "Configure DM access policies now? (default: pairing)",
        initialValue: false,
    });
    if (!wants) {
        return params.cfg;
    }
    let cfg = params.cfg;
    for (const policy of dmPolicies) {
        const accountId = accountIdsByChannel?.get(policy.channel);
        const { policyKey, allowFromKey } = policy.resolveConfigKeys?.(cfg, accountId) ?? {
            policyKey: policy.policyKey,
            allowFromKey: policy.allowFromKey,
        };
        await prompter.note([
            "Default: pairing (unknown DMs get a pairing code).",
            `Approve: ${formatCliCommand(`openclaw pairing approve ${policy.channel} <code>`)}`,
            `Allowlist DMs: ${policyKey}="allowlist" + ${allowFromKey} entries.`,
            `Public DMs: ${policyKey}="open" + ${allowFromKey} includes "*".`,
            "Multi-user DMs: run: " +
                formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
                ' (or "per-account-channel-peer" for multi-account channels) to isolate sessions.',
            `Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
        ].join("\n"), `${policy.label} DM access`);
        const nextPolicy = (await prompter.select({
            message: `${policy.label} DM policy`,
            options: [
                { value: "pairing", label: "Pairing (recommended)" },
                { value: "allowlist", label: "Allowlist (specific users only)" },
                { value: "open", label: "Open (public inbound DMs)" },
                { value: "disabled", label: "Disabled (ignore DMs)" },
            ],
        }));
        const current = policy.getCurrent(cfg, accountId);
        if (nextPolicy !== current) {
            cfg = policy.setPolicy(cfg, nextPolicy, accountId);
        }
        if (nextPolicy === "allowlist" && policy.promptAllowFrom) {
            cfg = await policy.promptAllowFrom({
                cfg,
                prompter,
                accountId,
            });
        }
    }
    return cfg;
}
