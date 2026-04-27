import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { formatCliCommand } from "../../cli/command-format.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { missingTargetError } from "./target-errors.js";
function buildWebChatDeliveryError() {
    return new Error(`Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`);
}
export function resolveOutboundTargetWithPlugin(params) {
    if (params.target.channel === INTERNAL_MESSAGE_CHANNEL) {
        return {
            ok: false,
            error: buildWebChatDeliveryError(),
        };
    }
    const plugin = params.plugin;
    if (!plugin) {
        return params.onMissingPlugin?.();
    }
    const allowFromRaw = params.target.allowFrom ??
        (params.target.cfg && plugin.config.resolveAllowFrom
            ? plugin.config.resolveAllowFrom({
                cfg: params.target.cfg,
                accountId: params.target.accountId ?? undefined,
            })
            : undefined);
    const allowFrom = allowFromRaw ? mapAllowFromEntries(allowFromRaw) : undefined;
    const effectiveTo = params.target.to?.trim() ||
        (params.target.cfg && plugin.config.resolveDefaultTo
            ? plugin.config.resolveDefaultTo({
                cfg: params.target.cfg,
                accountId: params.target.accountId ?? undefined,
            })
            : undefined);
    const resolveTarget = plugin.outbound?.resolveTarget;
    if (resolveTarget) {
        return resolveTarget({
            cfg: params.target.cfg,
            to: effectiveTo,
            allowFrom,
            accountId: params.target.accountId ?? undefined,
            mode: params.target.mode ?? "explicit",
        });
    }
    if (effectiveTo) {
        return { ok: true, to: effectiveTo };
    }
    const hint = plugin.messaging?.targetResolver?.hint;
    return {
        ok: false,
        error: missingTargetError(plugin.meta.label ?? params.target.channel, hint),
    };
}
