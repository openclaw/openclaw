import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { buildInitialChatSubmission } from "../chat/user-message-content.ts";
import type { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import { retainRejectedInitialTurn } from "./rejected-initial-turn.ts";
import type { StartedSessionNavigation } from "./started-session-navigation.ts";

/** Transfer accepted or rejected first-turn display through the existing owners. */
type InitialTurn = {
  context: ApplicationContext;
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  agentId: string;
  result: SessionCreateOutcome;
  turn: Parameters<typeof buildInitialChatSubmission>[1] & { attachments: ChatAttachment[] };
};

function retainInitialSessionTurn(options: InitialTurn): boolean {
  const { context, client, result, turn } = options;
  const { text: message, attachments } = turn;
  const handedOffAttachments =
    result.initialRun.status === "rejected" &&
    retainRejectedInitialTurn({
      agentId: options.agentId,
      attachments,
      context,
      error: result.initialRun.error,
      message,
      mentions: turn.mentions,
      sessionKey: result.key,
    });
  if (result.initialRun.status === "started") {
    context.chatSubmissions.retain(
      buildInitialChatSubmission(result.key, turn, client, result.initialRun.runId),
    );
  }
  return handedOffAttachments;
}

/** Settle only the captured draft and publish under the still-current route owner. */
export async function completeInitialSessionTurn(
  options: InitialTurn & {
    instant: InstantThreadHandoff | undefined;
    navigation: StartedSessionNavigation;
    isCurrent: () => boolean;
    clearDraft: (releasePayloads: boolean, keepPending?: boolean) => Promise<void>;
    completeInBackground: (key: string, runId?: string) => boolean;
    finishNavigation: () => void;
  },
) {
  const { context, client, agentId, result, instant } = options;
  const { key, initialRun } = result;
  if (instant) {
    await instant.waitForReady();
  }
  if (!options.isCurrent() || (instant && !instant.isCurrent())) {
    // A confirmed send retires its captured draft, but never publishes a first
    // turn into a different authenticated or navigation owner.
    if (initialRun.status !== "rejected") {
      await options.clearDraft(true, false);
    }
    return;
  }
  const handedOffAttachments = retainInitialSessionTurn(options);
  await options.clearDraft(!handedOffAttachments);
  if (!options.isCurrent() || (instant && !instant.isCurrent())) {
    return;
  }
  if (
    options.completeInBackground(
      key,
      initialRun.status === "started" ? initialRun.runId : undefined,
    )
  ) {
    return;
  }
  instant?.admitted(key, agentId);
  await options.navigation.navigate(
    context,
    { client, key, agentId },
    instant?.commit.bind(instant),
  );
  options.finishNavigation();
}
