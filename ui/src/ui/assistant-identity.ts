import { coerceIdentityValue } from "../../../src/shared/assistant-identity-values.js";

const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;

export const DEFAULT_ASSISTANT_NAME = "Assistant";
export const DEFAULT_ASSISTANT_AVATAR = "A";

export type AssistantIdentity = {
  agentId?: string | null;
  name: string;
  avatar: string | null;
};

export function normalizeAssistantIdentity(
  input?: Partial<AssistantIdentity> | null,
): AssistantIdentity {
  const name = coerceIdentityValue(input?.name, MAX_ASSISTANT_NAME) ?? DEFAULT_ASSISTANT_NAME;
  const avatar = coerceIdentityValue(input?.avatar ?? undefined, MAX_ASSISTANT_AVATAR) ?? null;
  const agentId =
    typeof input?.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : null;
  return { agentId, name, avatar };
}
