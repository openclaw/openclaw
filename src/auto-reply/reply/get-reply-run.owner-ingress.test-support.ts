import {
  createPreparedReplyTurn as turn,
  createProviderSurface,
  ownerParams,
} from "./get-reply-run.test-support.js";

export function createOwnerIngress(kind: string, channel: string, body: string, runId: string) {
  const params = ownerParams();
  params.command.senderId = "owner-1";
  params.command.senderIsOwner = kind !== "non-owner" && kind !== "discord-promoted-before-drain";
  return {
    ...params,
    ...turn(body, {
      ...createProviderSurface(channel),
      ChatType: "group",
      AccountId: kind === "telegram-named-account" ? "work" : undefined,
      SenderId:
        kind === "owner-alias" || kind === "discord-owner-alias" ? "transport-alias" : "owner-1",
      InboundEventKind: kind === "room-event" ? "room_event" : undefined,
      InputProvenance:
        kind === "internal" || kind === "inter-session"
          ? { kind: "inter_session" as const, sourceTool: "sessions_send" }
          : undefined,
    }),
    conversation: undefined,
    sessionEntry:
      kind === "spawned"
        ? { sessionId: "spawned-session", updatedAt: 1, spawnedBy: "agent:parent:main" }
        : undefined,
    opts: { runId, suppressNextUserMessagePersistence: kind === "replay" },
  };
}
