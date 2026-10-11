import type { SessionsCatalogListResult } from "../../../packages/gateway-protocol/src/index.ts";

export const catalogPage = (
  sessions: Array<{ threadId: string; name: string; sessionKey?: string; color?: string }>,
  nextCursor?: string,
  catalogId = "codex",
): SessionsCatalogListResult => ({
  catalogs: [
    {
      id: catalogId,
      label: catalogId === "codex" ? "Codex" : "Claude",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Codex",
          kind: "gateway" as const,
          connected: true,
          sessions: sessions.map((session) => ({
            ...session,
            status: "idle",
            archived: false,
            canContinue: true,
            canArchive: true,
          })),
          ...(nextCursor ? { nextCursor } : {}),
        },
      ],
    },
  ],
});

export const catalogErrorPage = (
  message: string,
  catalogId = "codex",
): SessionsCatalogListResult => ({
  catalogs: [
    {
      id: catalogId,
      label: catalogId === "codex" ? "Codex" : "Claude",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Unavailable host",
          kind: "gateway",
          connected: false,
          sessions: [],
          error: { code: "unavailable", message },
        },
      ],
    },
  ],
});
