import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccessRequest,
} from "./session-method-access.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
}): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  const connected = params.connected ?? true;
  return {
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    hello: {
      features: { methods: params.methods ?? ["sessions.create"] },
      ...(params.includeAuth === false
        ? {}
        : {
            auth: {
              role: "operator",
              scopes: params.scopes ?? ["operator.write"],
            },
          }),
    } as ApplicationGatewaySnapshot["hello"],
  };
}

function access(scopes: string[], request: SessionMethodAccessRequest) {
  return readSessionMethodAccess(snapshot({ methods: [request.method], scopes }), request);
}

describe("readSessionMethodAccess", () => {
  it.each(["operator.sessions.write", "operator.write"])("gates %s creation", (scope) => {
    const request = { method: "sessions.create", params: { agentId: "main", message: "Hello" } };
    expect(access([scope], request).allowed).toBe(scope === "operator.write");
    expect(access([scope], { ...request, sessionScope: true })).toEqual({
      allowed: true,
      requiredScope: "operator.sessions.write",
    });
    for (const params of [
      { incognito: true },
      { permissionMode: "full" },
      { execNode: "worker" },
      { toolOverrides: {} },
    ]) {
      expect(access([scope], { ...request, params, sessionScope: true })).toMatchObject({
        allowed: false,
        requiredScope: "operator.admin",
        cause: "missing-scope",
      });
    }
  });

  it("keeps profile placement admin-only through the caller's scope", () => {
    const request: SessionMethodAccessRequest = {
      method: "sessions.dispatch",
      params: { key: "agent:main:cloud", profileId: "aws" },
      requiredScope: "operator.admin",
    };
    expect(access(["operator.write"], request)).toMatchObject({
      allowed: false,
      requiredScope: "operator.admin",
    });
    expect(access(["operator.admin"], request)).toEqual({
      allowed: true,
      requiredScope: "operator.admin",
    });
  });

  it("allows write-scoped model changes while keeping read-only clients read-only", () => {
    for (const scope of [
      "operator.read",
      "operator.sessions.read",
      "operator.sessions.write",
      "operator.write",
      "operator.admin",
    ]) {
      expect(
        access([scope], {
          method: "sessions.patch",
          params: { key: "agent:main:main", model: null },
        }),
      ).toMatchObject({
        allowed: scope === "operator.write" || scope === "operator.admin",
        requiredScope: "operator.write",
      });
    }
  });

  it.each([
    { method: "sessions.patch", params: { key: "agent:main:notes", label: null } },
    { method: "sessions.create", params: { parentSessionKey: "main", fork: true } },
  ])("requires explicit opt-in and ownership for $method", (request) => {
    const scoped = snapshot({ methods: [request.method], scopes: ["operator.sessions.write"] });
    expect(
      readSessionMethodAccess(scoped, { ...request, session: { sharingRole: "owner" } }),
    ).toMatchObject({ allowed: false, requiredScope: "operator.write", cause: "missing-scope" });
    expect(
      readSessionMethodAccess(scoped, {
        ...request,
        sessionScope: true,
        session: { sharingRole: "owner" },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.sessions.write" });
    for (const session of [
      { sharingRole: "member" },
      { sharingRole: "viewer" },
      undefined,
    ] as const) {
      expect(
        readSessionMethodAccess(scoped, { ...request, sessionScope: true, session }),
      ).toMatchObject({
        allowed: false,
        requiredScope: "operator.sessions.write",
        cause: "session-not-owned",
      });
    }
    expect(
      access(["operator.write"], {
        ...request,
        sessionScope: true,
        session: { sharingRole: "viewer" },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.sessions.write" });
  });

  it("keeps context-window changes separate from write-scoped effort access", () => {
    expect(
      access(["operator.write"], {
        method: "sessions.patch",
        params: { key: "agent:main:main", contextWindow: null },
      }),
    ).toMatchObject({ allowed: false, cause: "missing-scope", requiredScope: "operator.admin" });
  });

  it("limits communication overrides and resets to write-scoped creators or admins", () => {
    for (const communication of [null, { send: "always" }, { receive: null }]) {
      for (const sharingRole of ["owner", "admin", "member", "viewer", undefined] as const) {
        for (const scope of [
          "operator.read",
          "operator.sessions.write",
          "operator.write",
          "operator.admin",
        ]) {
          const result = access([scope], {
            method: "sessions.patch",
            params: { communication },
            session: { sharingRole },
          });
          expect(result.allowed).toBe(
            scope === "operator.admin" ||
              (scope === "operator.write" && (sharingRole === "owner" || sharingRole === "admin")),
          );
        }
      }
    }
  });

  it("allows read, write, and admin scopes to satisfy read-scoped actions", () => {
    for (const method of ["session.members.list", "session.members.listEvidence"]) {
      for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
        expect(access([scope], { method, requiredScope: "operator.read" }).allowed).toBe(true);
      }
    }
  });

  it("rejects a read-scoped action without a compatible operator scope", () => {
    expect(
      access(["operator.approvals"], {
        method: "session.members.listEvidence",
        requiredScope: "operator.read",
      }),
    ).toMatchObject({ allowed: false, cause: "missing-scope", requiredScope: "operator.read" });
  });

  it.each([
    { state: snapshot({ includeAuth: false }), cause: "missing-scope" },
    { state: snapshot({ connected: false }), cause: "disconnected" },
    { state: snapshot({ methods: [] }), cause: "method-unavailable" },
  ])("rejects unavailable creation: $cause", ({ state, cause }) => {
    expect(readSessionMethodAccess(state, { method: "sessions.create" })).toMatchObject({
      allowed: false,
      cause,
    });
  });

  it("admits only opted-in desired-state assignments to a retained offline identity", () => {
    const offline = snapshot({ methods: ["sessions.patch"], scopes: ["operator.write"] });
    offline.phase = "offline";
    const request = {
      method: "sessions.patch",
      params: {
        key: "agent:main:notes",
        agentId: "main",
        expectedSessionId: "notes",
        label: "Notes",
      },
      allowDeferred: true,
    };
    expect(readSessionMethodAccess(offline, request).allowed).toBe(true);
    expect(readSessionMethodAccess(offline, { ...request, allowDeferred: false })).toMatchObject({
      allowed: false,
      cause: "disconnected",
    });
    for (const patch of [
      { model: "test-model" },
      { archived: true, pinned: false },
      { sidebarRoot: true },
      {},
    ]) {
      expect(
        readSessionMethodAccess(offline, {
          ...request,
          params: { key: "agent:main:notes", ...patch },
        }),
      ).toMatchObject({ allowed: false, cause: "disconnected" });
    }
    expect(readSessionMethodAccess({ ...offline, hello: null }, request).allowed).toBe(false);
    expect(readSessionMethodAccess({ ...offline, client: null }, request).allowed).toBe(false);
    expect(readSessionMethodAccess({ ...offline, phase: "stopped" }, request).allowed).toBe(false);
    Object.assign(offline.client!, { offlineRecoveryRetired: true });
    expect(readSessionMethodAccess(offline, request).allowed).toBe(false);
    expect(
      readSessionMethodAccess(snapshot({ connected: false }), {
        ...request,
        method: "sessions.patchMany",
        params: { patch: { label: "Notes" } },
      }).allowed,
    ).toBe(false);
  });

  it("rejects snapshots without method metadata", () => {
    const incomplete = snapshot({});
    incomplete.hello = { auth: incomplete.hello?.auth } as ApplicationGatewaySnapshot["hello"];
    expect(
      readSessionMethodAccess(incomplete, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      }),
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
  });
});
