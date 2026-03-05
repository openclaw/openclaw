import {
  makeWhatsAppDirectiveConfig,
  replyText,
  sessionStorePath,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

export async function runModelDirectiveText(
  home: string,
  body: string,
  options: {
    defaults?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    includeSessionStore?: boolean;
  } = {},
): Promise<string | undefined> {
  const res = await getReplyFromConfig(
    { Body: body, From: "+1222", To: "+1222", CommandAuthorized: true },
    {},
    makeWhatsAppDirectiveConfig(
      home,
      {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
        },
        ...options.defaults,
      },
      {
        ...(options.includeSessionStore === false
          ? {}
          : { session: { store: sessionStorePath(home) } }),
        ...options.extra,
      },
    ),
  );
  return replyText(res);
}
