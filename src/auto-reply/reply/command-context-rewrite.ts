import type { MsgContext, TemplateContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";

/** Keep every inbound-text projection aligned when command sugar becomes a normal agent turn. */
export function applyCommandTextToContext(
  ctx: MsgContext & Pick<TemplateContext, "BodyStripped">,
  text: string,
): void {
  ctx.commandText = text;
  ctx.agentText = text;
  ctx.rawText = text;
  ctx.Body = text;
  ctx.RawBody = text;
  ctx.CommandBody = text;
  ctx.BodyForCommands = text;
  ctx.BodyForAgent = text;
  ctx.BodyStripped = text;
}

export function applyCommandTextToParams(params: HandleCommandsParams, text: string): void {
  applyCommandTextToContext(params.ctx, text);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applyCommandTextToContext(params.rootCtx, text);
  }
  params.command.rawBodyNormalized = text;
  params.command.commandBodyNormalized = text;
}
