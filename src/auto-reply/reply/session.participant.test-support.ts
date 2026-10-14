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

  const profileContext = {
    RawBody: "authenticated input",
    ChatType: "direct" as const,
    SessionKey: "agent:main:profile-participant",
  };
  prepareSessionParticipantInput(profileContext, { type: "profile", id: "current-profile" }, 42);
  await initSessionState({ ctx: profileContext, cfg });
  await initSessionState({ ctx: { ...profileContext }, cfg });

  await initSessionState({
    ctx: {
      RawBody: "channel prompt",
      ChatType: "direct",
      SessionKey: "agent:main:channel-participant",
      SenderId: "channel-sender",
    },
    cfg,
  });
  await initSessionState({
    ctx: {
      RawBody: "unknown prompt",
      ChatType: "direct",
      SessionKey: "agent:main:unknown-participant",
    },
    cfg,
  });
  await initSessionState({
    ctx: {
      RawBody: "channel-created prompt",
      ChatType: "direct",
      SessionKey: "agent:main:channel-created-participant",
      SenderId: "channel-created-sender",
      SessionCreation: { via: "channel", actor: { type: "human", id: "channel-actor" } },
    },
    cfg,
  });
  await initSessionState({
    ctx: {
      RawBody: "own agent prompt",
      ChatType: "direct",
      SessionKey: "agent:main:own-agent-participant",
      SessionCreation: { via: "spawn", actor: { type: "agent", id: "main" } },
    },
    cfg,
  });
  await initSessionState({
    ctx: {
      RawBody: "delegated agent prompt",
      ChatType: "direct",
      SessionKey: "agent:main:delegated-agent-participant",
      SessionCreation: { via: "spawn", actor: { type: "agent", id: "research" } },
    },
    cfg,
  });

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
  expect(participants.get("agent:main:channel-participant")).toEqual([
    {
      identity: {
        type: "observation",
        id: "channel-sender",
        pluginId: null,
        accountId: null,
        senderKind: "unknown",
      },
      contributionCount: 1,
      firstPromptedAt: expect.any(Number),
      lastPromptedAt: expect.any(Number),
    },
  ]);
  expect(participants.get("agent:main:unknown-participant")).toBeUndefined();
  expect(participants.get("agent:main:channel-created-participant")).toEqual([
    {
      identity: {
        type: "observation",
        id: "channel-created-sender",
        pluginId: null,
        accountId: null,
        senderKind: "unknown",
      },
      contributionCount: 1,
      firstPromptedAt: expect.any(Number),
      lastPromptedAt: expect.any(Number),
    },
  ]);
  expect(participants.get("agent:main:own-agent-participant")).toBeUndefined();
  expect(participants.get("agent:main:delegated-agent-participant")).toBeUndefined();
}
