import { vi } from "vitest";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import * as directiveOverrides from "./get-reply-directives-apply.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  makeSessionEntry,
  replyDirectiveParams,
} from "./get-reply-directives.target-session.test-helpers.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import * as modelSelection from "./model-selection.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";

type DirectiveParams = Parameters<typeof resolveReplyDirectives>[0];

/** Exercise real authorization and sender projection without selecting or persisting a model. */
export async function routeReplyDirectivesForTest(
  ctx: FinalizedRuntimeMsgContext,
  overrides: Partial<Omit<DirectiveParams, "ctx">> = {},
) {
  const cfg = withFastReplyConfig(overrides.cfg ?? { commands: { text: true } });
  const params = replyDirectiveParams({
    ctx,
    sessionCtx: { ...ctx },
    sessionEntry: makeSessionEntry(),
    triggerBodyNormalized: ctx.commandText,
    commandAuthorized: ctx.CommandAuthorized,
    isGroup: ctx.ChatType === "group" || ctx.ChatType === "channel",
    storePath: undefined,
    ...overrides,
    cfg,
    agentCfg: overrides.agentCfg ?? cfg.agents?.defaults,
  });
  // Only downstream model facts and persistence are controlled; routing and its imports stay real.
  const selectModel = vi
    .spyOn(modelSelection, "createModelSelectionState")
    .mockImplementation(async (input) => ({
      ...createModelSelectionStateFixture(input),
      resolveDefaultThinkingLevel: async () => "off",
      resolveDefaultReasoningLevel: async () => "on",
    }));
  const applyOverrides = vi
    .spyOn(directiveOverrides, "applyInlineDirectiveOverrides")
    .mockImplementation(async (input) => ({
      kind: "continue",
      directives: input.directives,
      provider: input.provider,
      model: input.model,
      contextTokens: input.contextTokens,
    }));
  try {
    const result = await resolveReplyDirectives(params);
    if (result.kind !== "continue") {
      throw new Error("Expected directive routing to continue the reply");
    }
    return result.result;
  } finally {
    applyOverrides.mockRestore();
    selectModel.mockRestore();
  }
}
