import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import type { CliDeps } from "../cli/deps.types.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

export const REQUESTER = "agent:main:dashboard:session-tools-requester";
export const TARGET = "agent:main:dashboard:session-tools-target";
export const TARGET_ID = "session-tools-target-id";
export const INCOGNITO = "agent:main:dashboard:incognito-session-tools";
export const PARTICIPANT_SHARED = "agent:main:dashboard:participant-shared";
export const PARTICIPANT_DRAFT = "agent:main:dashboard:participant-draft";
export const PARTICIPANT_DRAFT_ID = "participant-draft-id";
let fixtureRun: Promise<void> | undefined;

export function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: state.workspaceDir },
          other: { workspace: state.path("other-workspace") },
        },
      },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    for (const [agentId, sessionKey, sessionId] of [
      ["main", REQUESTER, "session-tools-requester-id"],
      ["main", TARGET, TARGET_ID],
      ["main", INCOGNITO, "session-tools-incognito-id"],
      ["other", "agent:other:dashboard:session-tools-other", "session-tools-other-id"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility: "shared",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "other-person" },
        },
      );
    }
    const resources = new LegacyPluginSdkResourceHost();
    try {
      await resources.run(() =>
        withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
          run(cfg),
        ),
      );
    } finally {
      await resources.close();
    }
  }));
}

export function withParticipantSessionToolsFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    turn: Parameters<Parameters<typeof withPersonalToolTurn>[1]>[0];
    alice: Parameters<typeof withPersonalToolTurn>[0]["owner"];
    bob: Parameters<typeof withPersonalToolTurn>[0]["owner"];
  }) => Promise<void>,
) {
  return withSessionToolsFixture(async (cfg) => {
    const person = (name: string) => {
      const client = roleClient("write", `${name.toLowerCase()}-participant`);
      const profileId = client.authenticatedUserProfile?.profileId;
      if (!profileId) {
        throw new Error("expected participant profile");
      }
      return {
        profileId,
        senderId: `${name.toLowerCase()}-sender`,
        name,
        readCurrentRoleAssignment: () => "write",
      };
    };
    const alice = person("Alice");
    const bob = person("Bob");
    for (const [sessionKey, sessionId, visibility, marker] of [
      [PARTICIPANT_DRAFT, PARTICIPANT_DRAFT_ID, "draft", "Alice's distinctive draft marker"],
      [PARTICIPANT_SHARED, "participant-shared-id", "shared", "Shared participant marker"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility,
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: alice.profileId },
        },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId },
        { message: { role: "user", content: marker } },
      );
    }
    await withPersonalToolTurn(
      { owner: alice, sessionKey: REQUESTER, sessionId: "session-tools-requester-id" },
      async (turn) => {
        const runId = turn.runtimeIdentity.operationalRunInstance.runId;
        registerAgentRunContext(runId, {
          agentId: "main",
          sessionKey: REQUESTER,
          sessionId: "session-tools-requester-id",
        });
        try {
          await run({ cfg, turn, alice, bob });
        } finally {
          clearAgentRunContext(runId);
        }
      },
    );
  });
}

export async function drainSessionToolsFixture() {
  // Failed test callbacks can still hold isolated state; join cleanup before the next fixture.
  await fixtureRun?.catch(() => {});
  fixtureRun = undefined;
}
