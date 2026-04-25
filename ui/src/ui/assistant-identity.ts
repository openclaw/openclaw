import { coerceIdentityValue } from "../../../src/shared/assistant-identity-values.js";

const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;
const MAX_ASSISTANT_AVATAR_SOURCE = 500;

export const DEFAULT_ASSISTANT_NAME = "Assistant";
export const DEFAULT_ASSISTANT_AVATAR = "A";

export type AssistantIdentity = {
  agentId?: string | null;
  name: string;
  avatar: string | null;
  avatarSource?: string | null;
  avatarStatus?: "none" | "local" | "remote" | "data" | null;
  avatarReason?: string | null;
};

export function normalizeAssistantIdentity(
  input?: Partial<AssistantIdentity> | null,
): AssistantIdentity {
  const name = coerceIdentityValue(input?.name, MAX_ASSISTANT_NAME) ?? DEFAULT_ASSISTANT_NAME;
  const avatar = coerceIdentityValue(input?.avatar ?? undefined, MAX_ASSISTANT_AVATAR) ?? null;
  const avatarSource =
    coerceIdentityValue(input?.avatarSource ?? undefined, MAX_ASSISTANT_AVATAR_SOURCE) ?? null;
  const avatarStatus =
    input?.avatarStatus === "none" ||
    input?.avatarStatus === "local" ||
    input?.avatarStatus === "remote" ||
    input?.avatarStatus === "data"
      ? input.avatarStatus
      : null;
  const avatarReason =
    coerceIdentityValue(input?.avatarReason ?? undefined, MAX_ASSISTANT_AVATAR) ?? null;
  const agentId =
    typeof input?.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : null;
  return { agentId, name, avatar, avatarSource, avatarStatus, avatarReason };
}
