import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
} from "./github-publication-requester.test-support.js";
import {
  SESSION_ID,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";

const mocks = githubPublicationTestMocks();

describe("registered session GitHub publication access", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([
    { target: "own", policy: "absent", actor: "guest", outcome: "published" },
    { target: "own", policy: "write", actor: "guest", outcome: "published" },
    { target: "foreign", policy: "view", actor: "guest", outcome: "INVALID_REQUEST" },
    { target: "member", policy: "view", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "foreign", policy: "absent", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "member", policy: "absent", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "foreign", policy: "write", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "member", policy: "write", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "missing", policy: "absent", actor: "guest", outcome: "INVALID_REQUEST" },
    { target: "foreign", policy: "write", actor: "staff", outcome: "published" },
    { target: "foreign", policy: "absent", actor: "system", outcome: "published" },
    { target: "own", policy: "write", actor: "mixed", outcome: "published" },
    { target: "member", policy: "write", actor: "mixed", outcome: "UNAVAILABLE" },
  ] as const)(
    "checks $target target for $actor with role policy=$policy",
    async ({ target, policy, actor, outcome }) => {
      const f = await createRequesterPublicationFixture(vi.fn(), "local", {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      if (!f.local) {
        throw new Error("Expected a local publication fixture.");
      }
      const workspace = f.local;
      const roles = f.config.gateway!.roles!;
      const requestScopes: OperatorScope[] =
        actor === "mixed" ? ["operator.read", "operator.approvals", ...guestScopes] : guestScopes;
      setRuntimeConfigSnapshot({
        ...f.config,
        gateway: {
          ...f.config.gateway,
          roles:
            policy === "absent"
              ? undefined
              : {
                  ...roles,
                  definitions: {
                    ...roles.definitions,
                    guest: {
                      ...roles.definitions.guest!,
                      scopes: requestScopes,
                      sessions: { others: policy },
                    },
                  },
                },
        },
      });
      const profileId =
        actor === "staff"
          ? f.maintainerProfile
          : target === "own"
            ? f.guestProfile
            : (await ensureCanonicalUserProfileForEmail("publication-foreign@example.test")).id;
      const person = createOperatorWsClient({
        connId: profileId,
        scopes: actor === "staff" ? ["operator.write"] : requestScopes,
      });
      person.authenticatedUserProfile = {
        profileId,
        displayName: null,
        avatarRevision: "fixture",
        hasAvatar: false,
        updatedAt: 1,
      };
      prepareGatewayConnectOperatorAccess(person);
      if (target === "member") {
        expect(
          addSessionMember(
            { agentId: "main", sessionKey: SESSION_KEY },
            { identityId: profileId, addedBy: f.guestProfile },
          ).inserted,
        ).toBe(true);
      }
      const { loadGatewaySessionEntryReadOnly } =
        await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
      mocks.loadSession.mockImplementation(loadGatewaySessionEntryReadOnly);
      const request = vi.spyOn(f.coordinator, "requestForSession");
      const head = await workspace.git("rev-parse", "HEAD");
      const index = await fs.readFile(path.join(workspace.cwd, ".git/index"));
      const before = await workspace.git("diff", "HEAD");
      const respond = vi.fn();
      const params = {
        sessionKey: target === "missing" ? "agent:main:dashboard:missing" : SESSION_KEY,
        idempotencyKey: `${target}-${policy}-${actor}`,
      };
      await handleGatewayRequest({
        req: { type: "req", id: params.idempotencyKey, method: "sessions.github.publish", params },
        context: {
          ...f.guestSource.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        client:
          actor === "system"
            ? createSyntheticPluginRuntimeClient({
                operatorRoleActor: { kind: "system" },
                scopes: guestScopes,
              })
            : person,
        isWebchatConnect: () => false,
        respond,
      });
      if (outcome === "published") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "published" }),
        );
        expect(workspace.effects).toEqual(["push", "pull_request"]);
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: outcome }),
        );
        expect(request).not.toHaveBeenCalled();
        expect(workspace.effects).toEqual([]);
        expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
        expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
        expect(await workspace.git("diff", "HEAD")).toBe(before);
      }
    },
  );
});
