/** Resolves command text and fast model-directive eligibility for reply directives. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { type ModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

export function canUseFastExplicitModelDirective(params: {
  directives: InlineDirectives;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
}): boolean {
  const raw = normalizeOptionalString(params.directives.rawModelDirective);
  if (!raw || /^[0-9]+$/.test(raw)) {
    return false;
  }
  return Boolean(
    resolveModelRefFromString({
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    }),
  );
}

export function resolveDirectiveCommandText(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
}) {
  const commandSource =
    params.sessionCtx.BodyForCommands ??
    params.sessionCtx.CommandBody ??
    params.sessionCtx.RawBody ??
    params.sessionCtx.Transcript ??
    params.sessionCtx.BodyStripped ??
    params.sessionCtx.Body ??
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    "";
  const promptSource =
    params.sessionCtx.BodyForAgent ??
    params.sessionCtx.BodyStripped ??
    params.sessionCtx.Body ??
    "";
  return {
    commandSource,
    promptSource,
    commandText: commandSource || promptSource,
  };
}
