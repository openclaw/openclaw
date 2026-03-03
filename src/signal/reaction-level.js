import { resolveReactionLevel, } from "../utils/reaction-level.js";
import { resolveSignalAccount } from "./accounts.js";
/**
 * Resolve the effective reaction level and its implications for Signal.
 *
 * Levels:
 * - "off": No reactions at all
 * - "ack": Only automatic ack reactions (👀 when processing), no agent reactions
 * - "minimal": Agent can react, but sparingly (default)
 * - "extensive": Agent can react liberally
 */
export function resolveSignalReactionLevel(params) {
    const account = resolveSignalAccount({
        cfg: params.cfg,
        accountId: params.accountId,
    });
    return resolveReactionLevel({
        value: account.config.reactionLevel,
        defaultLevel: "minimal",
        invalidFallback: "minimal",
    });
}
