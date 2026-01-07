import type { TypingMode } from "../../config/types.js";

export type TypingModeContext = {
  configured?: TypingMode;
  isGroupChat: boolean;
  wasMentioned: boolean;
  isHeartbeat: boolean;
};

export const DEFAULT_GROUP_TYPING_MODE: TypingMode = "message";

export function resolveTypingMode({
  configured,
  isGroupChat,
  wasMentioned,
  isHeartbeat,
}: TypingModeContext): TypingMode {
  if (isHeartbeat) return "never";
  if (configured) return configured;
  if (!isGroupChat || wasMentioned) return "instant";
  return DEFAULT_GROUP_TYPING_MODE;
}

export const shouldStartTypingImmediately = (mode: TypingMode) =>
  mode === "instant";
