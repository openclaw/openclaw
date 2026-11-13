import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolveSessionForkParentError } from "./session-fork-access.js";

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  readResidentUserProfileAliases: () => new Set<string>(),
}));

type Params = Pick<
  CreateGatewaySessionParams,
  | "cfg"
  | "fork"
  | "applyAgentPermissionDefault"
  | "requestingOperatorProfileId"
  | "requestingOperatorScopes"
  | "operatorRoleActor"
>;
const key = "agent:main:dashboard:parent";
const restricted: SessionEntry = {
  sessionId: "parent",
  updatedAt: 1,
  createdActor: { type: "human", source: "profile", id: "creator" },
  access: { mode: "audience", profileIds: ["member"] },
};
const creator: Params = {
  cfg: {},
  fork: true,
  applyAgentPermissionDefault: true,
  requestingOperatorProfileId: "creator",
  requestingOperatorScopes: ["operator.write"],
};

describe("restricted fork authority", () => {
  it.each<[string, Params, boolean]>([
    ["direct creator without explicit role actor", creator, true],
    [
      "direct creator with matching actor",
      { ...creator, operatorRoleActor: { kind: "operator", profileId: "creator" } },
      true,
    ],
    [
      "direct admin",
      {
        ...creator,
        requestingOperatorProfileId: "admin",
        requestingOperatorScopes: ["operator.admin"],
      },
      true,
    ],
    ["selected participant", { ...creator, requestingOperatorProfileId: "member" }, false],
    [
      "delegated creator",
      {
        ...creator,
        applyAgentPermissionDefault: false,
        operatorRoleActor: { kind: "operator", profileId: "creator" },
      },
      false,
    ],
    [
      "delegated admin",
      {
        ...creator,
        applyAgentPermissionDefault: false,
        requestingOperatorScopes: ["operator.admin"],
      },
      false,
    ],
    [
      "system actor with creator profile and admin scope",
      {
        ...creator,
        operatorRoleActor: { kind: "system" },
        requestingOperatorScopes: ["operator.admin"],
      },
      false,
    ],
    [
      "mismatched operator actor",
      { ...creator, operatorRoleActor: { kind: "operator", profileId: "member" } },
      false,
    ],
    [
      "unidentified admin",
      {
        ...creator,
        requestingOperatorProfileId: undefined,
        requestingOperatorScopes: ["operator.admin"],
      },
      false,
    ],
    ["missing direct proof", { ...creator, applyAgentPermissionDefault: undefined }, false],
  ])("handles %s", (_label, params, allowed) => {
    const error = resolveSessionForkParentError(params, key, restricted);
    expect(error?.code).toBe(allowed ? undefined : "FORBIDDEN");
  });

  it("preserves unrestricted forks and non-fork links", () => {
    const delegated = { ...creator, applyAgentPermissionDefault: false };
    expect(
      resolveSessionForkParentError(delegated, key, {
        ...restricted,
        access: { mode: "unrestricted" },
      }),
    ).toBeUndefined();
    expect(
      resolveSessionForkParentError({ ...delegated, fork: false }, key, restricted),
    ).toBeUndefined();
  });

  it("treats unresolved source policies as restricted", () => {
    const error = resolveSessionForkParentError(
      { ...creator, applyAgentPermissionDefault: false },
      key,
      { ...restricted, access: { mode: "source" } },
    );
    expect(error?.code).toBe("FORBIDDEN");
  });
});
