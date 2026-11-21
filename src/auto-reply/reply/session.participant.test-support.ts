import path from "node:path";
import { expect } from "vitest";
import { listSessionParticipantsReadOnly } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { initSessionState } from "./test/session.test-support.js";

export async function expectSessionParticipantInputs(root: string) {
  const storePath = path.join(root, "sessions.json");
  const cfg = { session: { store: storePath } } as OpenClawConfig;
  const input = (name: string, extra: Record<string, unknown> = {}) => ({
    RawBody: `${name} prompt`,
    ChatType: "direct" as const,
    SessionKey: `agent:main:${name}-participant`,
    ...extra,
  });

  const profileContext = input("profile");
  prepareSessionParticipantInput(profileContext, { type: "profile", id: "current-profile" }, 42);
  await initSessionState({ ctx: profileContext, cfg });
  await initSessionState({ ctx: { ...profileContext }, cfg });

  for (const ctx of [
    input("channel", { SenderId: "channel-sender" }),
    input("unknown"),
    input("channel-created", {
      SenderId: "channel-created-sender",
      SessionCreation: { via: "channel", actor: { type: "human", id: "channel-actor" } },
    }),
    input("own-agent", { SessionCreation: { via: "spawn", actor: { type: "agent", id: "main" } } }),
    input("delegated-agent", {
      SessionCreation: { via: "spawn", actor: { type: "agent", id: "research" } },
    }),
  ]) {
    await initSessionState({ ctx, cfg });
  }

  await runOpenClawAgentWriteAdmission(
    toDatabaseOptions(resolveSqliteScope({ agentId: "main", storePath, sessionKey: "" })),
    () => undefined,
  );
  const participants = listSessionParticipantsReadOnly({ agentId: "main", storePath });
  expect(participants.get("agent:main:profile-participant")).toEqual([
    {
      identity: { type: "profile", id: "current-profile" },
      contributionCount: 1,
      firstPromptedAt: 42,
      lastPromptedAt: 42,
    },
  ]);
  for (const name of ["channel", "channel-created"]) {
    expect(participants.get(`agent:main:${name}-participant`)).toEqual([
      {
        identity: {
          type: "observation",
          id: `${name}-sender`,
          pluginId: null,
          accountId: null,
          senderKind: "unknown",
        },
        contributionCount: 1,
        firstPromptedAt: expect.any(Number),
        lastPromptedAt: expect.any(Number),
      },
    ]);
  }
  for (const name of ["unknown", "own-agent", "delegated-agent"]) {
    expect(participants.get(`agent:main:${name}-participant`)).toBeUndefined();
  }
}
