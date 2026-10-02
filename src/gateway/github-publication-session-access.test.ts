// Install shared transport mocks before publication owners enter the module cache.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
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
import type { OperatorScope } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
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
    { target: "own", policy: "absent", actor: "guest", outcome: "FORBIDDEN" },
    { target: "foreign", policy: "view", actor: "guest", outcome: "FORBIDDEN" },
    { target: "foreign", policy: "absent", actor: "guest", outcome: "FORBIDDEN" },
    { target: "foreign", policy: "write", actor: "guest", outcome: "FORBIDDEN" },
    { target: "member", policy: "write", actor: "guest", outcome: "FORBIDDEN" },
    { target: "missing", policy: "absent", actor: "guest", outcome: "FORBIDDEN" },
    { target: "foreign", policy: "write", actor: "staff", outcome: "published" },
    { target: "foreign", policy: "absent", actor: "system", outcome: "published" },
    { target: "own", policy: "write", actor: "mixed", outcome: "FORBIDDEN" },
    { target: "member", policy: "write", actor: "mixed", outcome: "FORBIDDEN" },
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
        const { inserted } = await addSessionMember(
          { agentId: "main", sessionKey: SESSION_KEY },
          { identityId: profileId, addedBy: f.guestProfile },
        );
        expect(inserted).toBe(true);
      }
      const { loadGatewaySessionEntryReadOnly } =
        await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
      mocks.loadSession.mockImplementation(loadGatewaySessionEntryReadOnly);
      const request = vi.spyOn(f.coordinator, "requestForSession");
      const head = await workspace.git("rev-parse", "HEAD");
      const index = await fs.readFile(path.join(workspace.cwd, ".git/index"));
      const before = await workspace.git("diff", "HEAD");
      const respond = vi.fn();
      const params: {
        sessionKey: string;
        idempotencyKey: string;
        review?: { reviewId: string; digest: string };
      } = {
        sessionKey: target === "missing" ? "agent:main:dashboard:missing" : SESSION_KEY,
        idempotencyKey: `${target}-${policy}-${actor}`,
      };
      const client =
        actor === "system"
          ? createSyntheticPluginRuntimeClient({
              operatorRoleActor: { kind: "system" },
              scopes: ["operator.write"],
            })
          : person;
      const context: GatewayRequestContext = {
        ...createContext(),
        ...f.guestSource.context,
        getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
          new Set(client.connId && (!filter || filter(client)) ? [client.connId] : []),
        githubPublicationService: f.coordinator,
      };
      if (outcome === "published") {
        const prepared = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: `prepare:${params.idempotencyKey}`,
            method: "sessions.github.review",
            params: { ...params, action: "prepare" },
          },
          context,
          client,
          isWebchatConnect: () => false,
          respond: prepared,
        });
        expect(prepared).toHaveBeenCalledWith(true, expect.objectContaining({ status: "ready" }));
        const candidate = prepared.mock.calls[0]![1];
        params.review = { reviewId: candidate.reviewId, digest: candidate.digest };
      }
      await handleGatewayRequest({
        req: { type: "req", id: params.idempotencyKey, method: "sessions.github.publish", params },
        context,
        client,
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
  it("lets an own-session guest request review without preparing credentials or publication", async () => {
    const f = await createRequesterPublicationFixture(vi.fn(), "local", {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    const respond = vi.fn();
    mocks.prepareIdentity.mockClear();
    mocks.runCommand.mockClear();
    const client = f.guestSource.client;
    const context: GatewayRequestContext = {
      ...createContext(),
      ...f.guestSource.context,
      getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
        new Set(client.connId && (!filter || filter(client)) ? [client.connId] : []),
      githubPublicationService: f.coordinator,
    };
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "request-review",
        method: "sessions.github.requestReview",
        params: { sessionKey: SESSION_KEY, idempotencyKey: "guest-review" },
      },
      context,
      client: f.guestSource.client,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "requested", digest: null, diffLength: 0 }),
    );
    expect(mocks.prepareIdentity).not.toHaveBeenCalled();
    expect(
      mocks.runCommand.mock.calls.every(([argv]) => argv[0] !== "gh" && !argv.includes("diff")),
    ).toBe(true);
    expect(f.externalWrites).toEqual([]);
    respond.mockClear();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "prepare-review",
        method: "sessions.github.review",
        params: { sessionKey: SESSION_KEY, idempotencyKey: "guest-prepare", action: "prepare" },
      },
      context,
      client: f.guestSource.client,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.write" }),
    );
  });
});
