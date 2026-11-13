import type { UserProfile } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import type { TeamScaleFixtureAsset } from "./control-ui-team-scale-history-fixture.ts";
import { TEAM_SCALE_AVATAR_ASSET } from "./control-ui-team-scale-people.ts";

export function prepareTeamScalePaneFixture(input: {
  options: {
    paneChromeFacts?: boolean;
    transcriptAvatars?: boolean;
    lateRowFacts?: boolean;
    detailsSessionFacts?: boolean;
  };
  baseUrl: string;
  now: number;
  people: ControlUiMockPresenceUser[];
  profiles: UserProfile[];
  agents: AgentsListResult;
  assets: Map<string, TeamScaleFixtureAsset>;
  session: GatewaySessionRow;
}) {
  const { options, baseUrl, now, people, profiles, agents, assets, session } = input;
  const senderIndex = options.paneChromeFacts ? 0 : 4;
  const transcriptSender = people[senderIndex]!;
  if (options.paneChromeFacts) {
    delete session.parentSessionKey;
    Object.assign(session, {
      color: "blue",
      spawnedWorkspaceDir: "/workspace/observatory",
      participants: [{ identity: transcriptSender.identity, label: transcriptSender.name }],
      expandedParticipants: [{ identity: transcriptSender.identity, label: transcriptSender.name }],
    });
  }
  const avatarAsset = {
    ...TEAM_SCALE_AVATAR_ASSET,
    headers: { "Cache-Control": "private, max-age=31536000, immutable" },
  };
  if (options.transcriptAvatars) {
    transcriptSender.avatarUrl = `/api/users/${transcriptSender.id}/avatar?v=${now}`;
    Object.assign(profiles[senderIndex]!, { hasAvatar: true, avatarMime: "image/png" });
    assets.set(`/api/users/${transcriptSender.id}/avatar`, avatarAsset);
  }
  if (options.lateRowFacts) {
    for (const agent of agents.agents) {
      const path = `/avatar/${agent.id}`;
      agent.identity = { ...agent.identity, avatarUrl: `${path}?v=${now}` };
      assets.set(path, avatarAsset);
    }
  }
  const groups = Array.from({ length: 97 }, (_, index) => `Fixture group ${index + 1}`);
  const paneChromeSettings: Record<string, string> = options.paneChromeFacts
    ? {
        "openclaw:sidebar:sessions:grouping": "category",
        "openclaw:sidebar:sessions:sort-mode": "created",
        "openclaw:sidebar:sessions:show-preview": "false",
        "openclaw:sidebar:sessions:hide-empty-groups": "true",
        "openclaw:sidebar:sessions:collapsed-sections": JSON.stringify(
          groups.slice(-5).map((name) => `category:${name}`),
        ),
      }
    : {};
  if (options.detailsSessionFacts) {
    Object.assign(session, {
      createdActor: { type: "system", id: "gateway", label: "Synthetic creator" },
      participantCount: 3,
      worktree: {
        id: "synthetic-tree",
        branch: "feature/verification",
        repoRoot: "/workspace/proof",
      },
    });
    const gatewayUrl = `ws://${new URL(baseUrl).host}`;
    const profile = encodeURIComponent(people.find((person) => person.self)!.id);
    Object.assign(paneChromeSettings, {
      [`openclaw.control.sidebarSessionOwnerFilter.v1:${gatewayUrl}:${profile}`]: "involving-me",
      [`openclaw.control.sidebarEmptyGroups.v1:${gatewayUrl}:user:${profile}`]: "always",
      "openclaw:sidebar:sessions:hide-empty-groups": "false",
    });
  }
  const paneMethodResponses = options.paneChromeFacts
    ? {
        "sessions.branches.list": {
          branches: [
            {
              leafEntryId: "saved-current",
              headline: "Current version",
              messageCount: 4,
              active: true,
            },
            {
              leafEntryId: "saved-earlier",
              headline: "Earlier version",
              messageCount: 2,
              active: false,
            },
          ],
        },
      }
    : {};
  const methodResponses = {
    ...paneMethodResponses,
    ...(options.detailsSessionFacts
      ? {
          "sessions.groups.list": {
            groups: Array.from({ length: 97 }, (_, index) => ({
              name: `Fixture group ${index + 1}`,
              position: index,
            })),
            sectionOrder: [
              "work",
              "groups",
              "ungrouped",
              "catalog:cron",
              "catalog:terminal",
              ...Array.from({ length: 97 }, (_, index) => `category:Fixture group ${index + 1}`),
            ],
          },
        }
      : {}),
  };
  return { transcriptSender, paneMethodResponses: methodResponses, paneChromeSettings };
}
