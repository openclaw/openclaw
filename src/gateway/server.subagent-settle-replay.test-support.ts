import type { agentCommand } from "../agents/agent-command.js";

export const createRequesterFinalResult = (): Exclude<
  Awaited<ReturnType<typeof agentCommand>>,
  void
> => ({
  payloads: [{ text: "Requester synthesis is complete.", mediaUrl: null }],
  meta: { durationMs: 1, finalAssistantVisibleText: "Requester synthesis is complete." },
  deliveryStatus: {
    requested: true,
    attempted: true,
    succeeded: true,
    status: "sent",
    resultCount: 1,
  },
});
