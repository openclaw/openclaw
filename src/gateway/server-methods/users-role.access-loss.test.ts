import { expect, it } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { roleChangeLosesAccess } from "./users-role.js";

const role = (
  sessions: GatewayOperatorRoleDefinition["sessions"],
  scopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.read", "operator.write"],
): GatewayOperatorRoleDefinition => ({ agents: ["main"], scopes, sessions });

const cfg: OpenClawConfig = {
  gateway: {
    roles: {
      default: "viewer",
      assignments: { byGithubLogin: { carol: "writer" } },
      definitions: {
        none: role({ others: "none" }),
        viewer: role({ others: "view" }),
        writer: role({ others: "write" }),
        invitedSend: role({ others: "invited", maxInvitedAccess: "send" }),
        invitedRead: role({ others: "invited", maxInvitedAccess: "read" }),
        invitedUncapped: role({ others: "invited" }),
        invitedSendExec: role({
          others: "invited",
          maxInvitedAccess: "send",
          invitedTools: ["read", "exec"],
        }),
        reader: role({ others: "view" }, ["operator.read"]),
      },
    },
  },
};
const loses = (previousRole: string | null, newRole: string | null, githubLogin?: string) =>
  roleChangeLosesAccess(
    cfg,
    { profileId: "carol-profile", previousRole, role: newRole },
    { githubLogin: githubLogin ?? null },
  );

it.each([
  ["none", "viewer", false],
  ["viewer", "writer", false],
  ["invitedRead", "invitedSend", false],
  ["invitedSend", "writer", false],
  // Invited tool limits apply to the next request, in either direction.
  ["invitedSend", "invitedSendExec", false],
  ["invitedSend", "invitedUncapped", false],
  ["invitedUncapped", "invitedRead", true],
  // Without a ceiling a member's stored level is ignored; any ceiling applies it, so a member
  // stored at read drops to read.
  ["invitedUncapped", "invitedSend", true],
  ["viewer", "viewer", false],
  ["viewer", "none", true],
  ["invitedSend", "invitedRead", true],
  ["invitedSend", "viewer", true],
  ["viewer", "reader", true],
])("%s -> %s loses access: %s", (previousRole, newRole, expected) => {
  expect(loses(previousRole, newRole)).toBe(expected);
});

it("compares the effective role, including a GitHub-login assignment", () => {
  // Unassigned Carol is a writer through her GitHub login; an explicit viewer role narrows her.
  expect(loses(null, "viewer", "carol")).toBe(true);
  // Clearing an explicit writer back to the same GitHub-login writer changes nothing.
  expect(loses("writer", null, "carol")).toBe(false);
});
