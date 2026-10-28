import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { preparePersonalForgeToolAction } from "./personal-forge-tool-authorization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const profileState = vi.hoisted(() => ({
  current: true,
  ready: undefined as undefined | (() => void),
}));
// mock-isolation: profile storage is independent of the host-issued run authority tested here.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRolePolicyAuthority: async (profileId: string) => {
    profileState.ready?.();
    return { profileId, role: null, githubLogin: null, isCurrent: () => profileState.current };
  },
}));

function turn(scopes = ["operator.sessions.read", "operator.sessions.write"]) {
  let active = true;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "alice",
    scopes,
    assertCurrent: () => {
      if (!active) {
        throw new Error("requester revoked");
      }
    },
  });
  const identity = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:bobs-session",
    operationalRunInstance: { instanceId: "issue-test", runId: "issue-run" },
    operatorAuthority: authority,
    receiptAuthority: () => active,
    assertToolAllowed: vi.fn(),
  };
  const options = {
    client: {
      connect: gatewayConnect(scopes),
      // Neither session owner nor a copied client projection chooses the OAuth owner.
      authenticatedUserProfile: gatewayProfile("bob", "Bob", 1),
      internal: { syntheticClient: true, operatorRunAuthority: authority },
    },
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions;
  return {
    identity,
    options,
    revoke: () => {
      active = false;
    },
    prepare: (write = false) =>
      withGatewayToolCallerIdentity(identity, () =>
        preparePersonalForgeToolAction(
          options,
          "gitlab_issues",
          write ? "operator.sessions.write" : "operator.sessions.read",
          "GitLab",
        ),
      ),
  };
}

describe("requester-bound forge tool authority", () => {
  beforeEach(() => {
    profileState.current = true;
    profileState.ready = undefined;
  });

  it("uses the admitted requester in a foreign-owned session and retains live authority", async () => {
    const current = turn();
    const action = await current.prepare(true);
    expect(action.owner).toBe("alice");
    expect(current.identity.assertToolAllowed).toHaveBeenCalledWith("gitlab_issues");
    action.assertCurrent();
    current.revoke();
    expect(action.assertCurrent).toThrow(/revoked|active/);
  });

  it.each(["missing run", "copied profile", "different source"])("rejects %s", async (kind) => {
    const current = turn();
    if (kind === "different source") {
      current.options.client!.internal!.operatorRunAuthority = createAdmittedRunOperatorAuthority({
        profileId: "alice",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
    } else if (kind === "copied profile") {
      delete current.options.client!.internal!.operatorRunAuthority;
    }
    const pending =
      kind === "missing run"
        ? preparePersonalForgeToolAction(
            current.options,
            "gitlab_issues",
            "operator.sessions.read",
            "GitLab",
          )
        : current.prepare();
    await expect(pending).rejects.toThrow(/admitted/);
  });

  it("does not widen a read-only requester for an issue write", async () => {
    const current = turn(["operator.sessions.read"]);
    expect((await current.prepare()).owner).toBe("alice");
    await expect(current.prepare(true)).rejects.toThrow(/operator.sessions.write/);
  });

  it("rechecks revocation during profile preparation and before later effects", async () => {
    const current = turn();
    profileState.ready = current.revoke;
    await expect(current.prepare()).rejects.toThrow(/revoked|active/);
    const replacement = turn();
    profileState.ready = undefined;
    const action = await replacement.prepare();
    profileState.current = false;
    expect(action.assertCurrent).toThrow(/profile changed/);
  });

  it("retains narrowed dispatch scopes independently of the original requester grant", async () => {
    const current = turn();
    current.options.client!.connect.scopes = ["operator.sessions.read"];
    await expect(current.prepare(true)).rejects.toThrow(/operator.sessions.write/);
  });
});
