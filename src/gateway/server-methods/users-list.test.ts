import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { UsersListResultSchema } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { usersHandlers } from "./users.js";

const listProfiles = vi.hoisted(() => vi.fn());
const readUserProfileSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profiles.js")>()),
  listProfiles,
}));
vi.mock("../../state/user-profile-reads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-reads.js")>()),
  readUserProfileSnapshot,
}));

const profile = {
  displayName: "Operator",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 1,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
};

async function runUsersHandler(
  params: Record<string, unknown>,
  context: Pick<GatewayRequestHandlerOptions["context"], "getRuntimeConfig">,
) {
  const respond = vi.fn();
  await usersHandlers["users.list"]!({
    req: { type: "req", id: "users-list", method: "users.list", params },
    client: null,
    isWebchatConnect: () => false,
    params,
    respond,
    context: createDirectChatContext(context),
  });
  return respond;
}

it.each([false, true])(
  "lists effective roles and sources without replacing explicit assignments (GitHub lookup: %s)",
  async (lookup) => {
    const githubIdentity = {
      login: "Release-Operator",
      profileUrl: "https://github.com/Release-Operator",
      avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
    };
    const profiles = [
      { ...profile, id: "assigned", role: "guest", githubIdentity },
      { ...profile, id: "mapped", githubIdentity },
      { ...profile, id: "default" },
      { ...profile, id: "merged", role: "guest", mergedInto: "mapped" },
    ];
    listProfiles.mockResolvedValue(profiles);
    readUserProfileSnapshot.mockResolvedValue({
      profiles,
      githubProfiles: [{ accountId: 42, profileId: "mapped" }],
    });
    const respond = await runUsersHandler(lookup ? { githubAccountIds: [42] } : {}, {
      getRuntimeConfig: () => ({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: { sessions: { others: "view" }, agents: [], scopes: [] },
              release_admin: {
                sessions: { others: "write" },
                agents: "*",
                scopes: ["operator.admin"],
              },
            },
            assignments: { byGithubLogin: { "release-operator": "release_admin" } },
          },
        },
      }),
    });
    const result = respond.mock.calls[0]?.[1];
    expect(result.profiles).toMatchObject([
      { id: "assigned", role: "guest", effectiveRole: "guest", roleSource: "assigned" },
      { id: "mapped", effectiveRole: "release_admin", roleSource: "githubLogin" },
      { id: "default", effectiveRole: "guest", roleSource: "default" },
      { id: "merged", role: "guest", effectiveRole: "release_admin", roleSource: "githubLogin" },
    ]);
    expect(result.profiles[1]).not.toHaveProperty("role");
    expect(Value.Check(UsersListResultSchema, result)).toBe(true);
    if (lookup) {
      expect(result.githubProfiles).toEqual([{ accountId: 42, profileId: "mapped" }]);
    }
  },
);
