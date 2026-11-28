import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { SessionMembersListEvidenceResultSchema } from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { setDisplayName, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { createSharingState, seedSharingSession } from "./sessions-sharing-state.test-support.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
} from "./sessions-sharing.test-support.js";

it("manages bounded invitation levels without granting send members session management", () =>
  createSharingState(() => setRuntimeConfigSnapshot({}))(async () => {
    const owner = ensureProfileForEmail("access-owner@example.test");
    const guest = ensureProfileForEmail("access-guest@example.test");
    const ordinary = ensureProfileForEmail("access-ordinary@example.test");
    setUserProfileRole(guest.id, "guest");
    setDisplayName(guest.id, "Alice Collaborator");
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "ordinary",
          definitions: {
            ordinary: {
              scopes: ["operator.read", "operator.write"],
              agents: "*",
              sessions: { others: "write" },
            },
            guest: {
              scopes: ["operator.read", "operator.write"],
              agents: "*",
              sessions: { others: "invited", maxInvitedAccess: "send" },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:bounded-invitations";
    await seedSharingSession(sessionKey, "bounded-invitations", {
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    const broadcast = vi.fn();
    const context = sessionSharingTestContext(broadcast, cfg);
    const ownerClient = identifiedClient(owner.id);
    const guestClient = identifiedClient(guest.id);
    guestClient.internal = { ...guestClient.internal, authenticatedOperator: true };
    const call = (
      method: Parameters<typeof callSessionSharingHandler>[0],
      params: Record<string, unknown> = {},
      client = ownerClient,
    ) => callSessionSharingHandler(method, { sessionKey, ...params }, context, client);
    for (const type of ["agent", "system"] as const) {
      await seedSharingSession(`agent:main:${type}-grant-source`, type, {
        createdActor: { type, id: type },
      });
      expect((await call("session.members.add", { identityId: type }))[0]?.[0]).toBe(true);
      for (const method of ["session.members.add", "session.members.setAccess"] as const) {
        expect((await call(method, { identityId: type, access: "read" }))[0]?.[0]).toBe(false);
      }
      expect((await call("session.members.remove", { identityId: type }))[0]?.[0]).toBe(true);
    }
    const evidence = async () =>
      Value.Decode(
        SessionMembersListEvidenceResultSchema,
        (await call("session.members.listEvidence"))[0]?.[1],
      );
    const authorize = async (method: string, requestParams: Record<string, unknown>) => {
      const result = await resolveSessionMutationAuthorizationAsync({
        method,
        requestParams,
        client: guestClient,
        context,
      });
      result.authorization?.release?.();
      return result.error;
    };
    expect(
      authorizeOperatorScopesForMethod("session.members.setAccess", ["operator.sessions.read"])
        .allowed,
    ).toBe(false);
    expect(
      (await call("session.members.setAccess", { identityId: guest.id, access: "send" }))[0]?.[0],
    ).toBe(false);
    expect(
      (await call("session.members.add", { identityId: ordinary.id, access: "read" }))[0]?.[0],
    ).toBe(false);
    expect((await evidence()).permissions).toContainEqual({
      identityId: guest.id,
      level: "read",
      options: ["read", "suggest", "send"],
      invitation: "available",
    });
    expect((await call("session.members.add", { identityId: guest.id }))[0]?.[0]).toBe(true);
    for (const access of ["read", "suggest", "send"] as const) {
      if (access !== "read") {
        expect(
          (await call("session.members.setAccess", { identityId: guest.id, access }))[0]?.[0],
        ).toBe(true);
      }
      const listed = await evidence();
      expect(listed.members).toMatchObject([{ identityId: guest.id, access }]);
      expect(listed.permissions).toContainEqual({
        identityId: guest.id,
        level: access,
        options: ["read", "suggest", "send"],
        invitation: "member",
      });
      expect((await authorize("chat.send", { sessionKey })) === null).toBe(access === "send");
    }
    for (const [method, requestParams] of [
      ["sessions.patch", { key: sessionKey, archived: true }],
      ["sessions.patch", { key: sessionKey, label: "forbidden" }],
      ["sessions.assignOwner", { key: sessionKey, owner: { type: "human", id: guest.id } }],
      ["sessions.patch", { key: sessionKey, displayName: "forbidden" }],
    ] as const) {
      expect(await authorize(method, requestParams), method).not.toBeNull();
    }
    for (const [method, params] of [
      ["session.visibility.set", { visibility: "shared" }],
      ["session.members.add", { identityId: ordinary.id }],
      ["session.members.remove", { identityId: guest.id }],
      ["session.members.setAccess", { identityId: guest.id, access: "read" }],
    ] as const) {
      expect((await call(method, params, guestClient))[0]?.[0], method).toBe(false);
    }
    expect(
      (await call("session.members.add", { identityId: guest.id, access: "read" }))[0]?.[0],
    ).toBe(true);
    expect((await evidence()).members[0]?.access).toBe("send");
    await call("session.visibility.set", { visibility: "shared" });
    expect((await evidence()).permissions).toContainEqual({
      identityId: guest.id,
      level: "send",
      options: ["read", "suggest", "send"],
      invitation: "member",
    });
    await call("session.visibility.set", { visibility: "draft" });
    expect((await evidence()).permissions).toContainEqual({
      identityId: guest.id,
      level: "send",
      options: ["read", "suggest", "send"],
      invitation: "member",
    });
    await call("session.visibility.set", { visibility: "shared" });
    cfg.gateway!.roles!.definitions.guest!.sessions.maxInvitedAccess = "suggest";
    setRuntimeConfigSnapshot(cfg);
    expect(
      (await call("session.members.setAccess", { identityId: guest.id, access: "send" }))[0]?.[0],
    ).toBe(false);
    const admin = identifiedClient(ordinary.id);
    admin.connect.scopes = ["operator.admin"];
    expect(
      (
        await call("session.members.setAccess", { identityId: guest.id, access: "read" }, admin)
      )[0]?.[0],
    ).toBe(true);
    expect((await evidence()).permissions).toContainEqual({
      identityId: guest.id,
      level: "read",
      options: ["read", "suggest"],
      invitation: "member",
    });
    expect((await call("session.members.remove", { identityId: guest.id }))[0]?.[0]).toBe(true);
    expect((await evidence()).members).toEqual([]);
    await addSessionMember(
      { agentId: "main", sessionKey },
      { identityId: guest.id, addedBy: owner.id, addedAt: Date.now() },
    );
    expect((await evidence()).permissions).toContainEqual({
      identityId: guest.id,
      level: "read",
      options: ["read", "suggest"],
      invitation: "member",
    });
    const events = broadcast.mock.calls
      .filter(([name]) => name === "session.sharing")
      .map(([, event]) => event);
    expect(
      events
        .filter((event) => event.action === "member-access-changed")
        .map((event) => event.access),
    ).toEqual(["suggest", "send", "read"]);
    expect(
      events.find((event) => event.action === "member-added" && event.identityId === guest.id)
        ?.access,
    ).toBe("read");
    expect(events.filter((event) => event.access)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "member-added",
          identityId: guest.id,
          identityLabel: "Alice Collaborator",
        }),
        ...["suggest", "send", "read"].map((access) =>
          expect.objectContaining({
            action: "member-access-changed",
            identityId: guest.id,
            identityLabel: "Alice Collaborator",
            access,
          }),
        ),
      ]),
    );
    expect(events.at(-1)?.action).toBe("member-removed");
    for (const method of ["session.members.add", "session.members.setAccess"] as const) {
      if (method === "session.members.add") {
        await call("session.members.remove", { identityId: guest.id });
      } else {
        await call("session.members.setAccess", { identityId: guest.id, access: "read" });
      }
      cfg.gateway!.roles!.definitions.guest!.sessions.maxInvitedAccess = "send";
      let changed = false;
      const probe = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
        if (request.stage === "commit") {
          changed = true;
          cfg.gateway!.roles!.definitions.guest!.sessions.maxInvitedAccess = "suggest";
        }
        admit(request, grant);
      });
      try {
        expect((await call(method, { identityId: guest.id, access: "send" }))[0]?.[0]).toBe(true);
        expect(changed).toBe(true);
      } finally {
        probe.mockRestore();
      }
    }
  }));
