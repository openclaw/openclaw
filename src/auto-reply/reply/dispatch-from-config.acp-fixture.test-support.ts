import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta-read.types.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type AcpSessionFixture = Partial<Omit<AcpSessionStoreEntry, "entry" | "acp">> & {
  entry?: Partial<SessionEntry>;
  acp?: Partial<SessionAcpMeta>;
};

export function completeAcpSessionFixture(
  fixture: AcpSessionFixture | null,
  params: { sessionKey: string; agentId?: string; cfg?: OpenClawConfig; storePath: string },
): AcpSessionStoreEntry | null {
  if (!fixture) {
    return null;
  }
  return {
    ...fixture,
    cfg: fixture.cfg ?? params.cfg ?? {},
    storePath: fixture.storePath ?? params.storePath,
    sessionKey: fixture.sessionKey ?? params.sessionKey,
    storeSessionKey: fixture.storeSessionKey ?? fixture.sessionKey ?? params.sessionKey,
    entry: fixture.entry && { sessionId: "mock-session", updatedAt: 1, ...fixture.entry },
    acp: fixture.acp && {
      backend: "acpx",
      agent: params.agentId ?? "main",
      runtimeSessionName: "runtime:mock",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
      ...fixture.acp,
    },
  };
}
