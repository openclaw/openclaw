import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { SessionMemberPermission } from "../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { ChatSessionSharingProps } from "../pages/chat/components/chat-session-sharing-shared.tsx";
import { ChatSessionSharing } from "../pages/chat/components/chat-session-sharing.solid.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";

export function mountPeopleSharing(
  count: number,
  onMemberChange: ChatSessionSharingProps["onMemberChange"],
  memberIds: string[] = [],
) {
  const key = "agent:main:people";
  return mountSolid(() =>
    createComponent(ChatSessionSharing, {
      session: { key, kind: "direct", updatedAt: 1, sharingRole: "owner", visibility: "read-only" },
      state: {
        loading: false,
        result: {
          sessionKey: key,
          role: "owner",
          allowedVisibilities: ["read-only"],
          permissions: Array.from({ length: count }, (_, i): SessionMemberPermission => ({
            identityId: `person-${i}`,
            level: memberIds.includes(`person-${i}`) ? "send" : "read",
            options: ["read", "send"],
          })),
          members: memberIds.map((identityId) => ({ identityId, addedBy: "owner", addedAt: 1 })),
          identities: Array.from({ length: count }, (_, i) => ({
            type: "human" as const,
            id: `person-${i}`,
            label: `Person ${String(i).padStart(4, "0")}`,
          })),
        },
      },
      onOpen: vi.fn(),
      onVisibilityChange: vi.fn(),
      onMemberChange,
    }),
  ).container;
}
