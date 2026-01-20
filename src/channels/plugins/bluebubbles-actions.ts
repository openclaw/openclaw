import type { ChannelMessageActionName } from "./types.js";

export type BlueBubblesActionSpec = {
  gate: string;
  groupOnly?: boolean;
  unsupportedOnMacOS26?: boolean;
};

export const BLUEBUBBLES_ACTIONS = {
  react: { gate: "reactions" },
  edit: { gate: "edit", unsupportedOnMacOS26: true },
  unsend: { gate: "unsend" },
  reply: { gate: "reply" },
  sendWithEffect: { gate: "sendWithEffect" },
  renameGroup: { gate: "renameGroup", groupOnly: true },
  setGroupIcon: { gate: "setGroupIcon", groupOnly: true },
  addParticipant: { gate: "addParticipant", groupOnly: true },
  removeParticipant: { gate: "removeParticipant", groupOnly: true },
  leaveGroup: { gate: "leaveGroup", groupOnly: true },
  sendAttachment: { gate: "sendAttachment" },
} as const satisfies Partial<Record<ChannelMessageActionName, BlueBubblesActionSpec>>;

export const BLUEBUBBLES_ACTION_NAMES = Object.keys(
  BLUEBUBBLES_ACTIONS,
) as ChannelMessageActionName[];

export const BLUEBUBBLES_GROUP_ACTIONS = new Set<ChannelMessageActionName>(
  BLUEBUBBLES_ACTION_NAMES.filter((action) => BLUEBUBBLES_ACTIONS[action]?.groupOnly),
);
