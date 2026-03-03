import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { formatLinkUnderstandingBody } from "./format.js";
import { runLinkUnderstanding } from "./runner.js";
export async function applyLinkUnderstanding(params) {
    const result = await runLinkUnderstanding({
        cfg: params.cfg,
        ctx: params.ctx,
    });
    if (result.outputs.length === 0) {
        return result;
    }
    params.ctx.LinkUnderstanding = [...(params.ctx.LinkUnderstanding ?? []), ...result.outputs];
    params.ctx.Body = formatLinkUnderstandingBody({
        body: params.ctx.Body,
        outputs: result.outputs,
    });
    finalizeInboundContext(params.ctx, {
        forceBodyForAgent: true,
        forceBodyForCommands: true,
    });
    return result;
}
