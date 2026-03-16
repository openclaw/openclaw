import { getGlobalHookRunner } from "./hook-runner-global.js";

export async function runOutboundMessageHook(params: {
  to: string;
  content: string;
  channel: string;
  accountId?: string;
}): Promise<{ content: string } | null> {
  const runner = getGlobalHookRunner();
  if (!runner || !runner.hasHooks("message_sending")) {
    return { content: params.content };
  }
  try {
    const result = await runner.runMessageSending(
      { to: params.to, content: params.content },
      { channelId: params.channel, accountId: params.accountId },
    );
    if (result?.cancel) {
      return null;
    }
    return { content: result?.content ?? params.content };
  } catch {
    return { content: params.content };
  }
}
