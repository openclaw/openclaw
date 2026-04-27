import { formatCliCommand } from "../cli/command-format.js";
export function buildPairingReply(params) {
    const { channel, idLine, code } = params;
    const approveCommand = formatCliCommand(`openclaw pairing approve ${channel} ${code}`);
    return [
        "OpenClaw: access not configured.",
        "",
        idLine,
        "Pairing code:",
        "```",
        code,
        "```",
        "",
        "Ask the bot owner to approve with:",
        formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
        "```",
        approveCommand,
        "```",
    ].join("\n");
}
