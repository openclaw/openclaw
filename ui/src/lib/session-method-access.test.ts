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
  it("admits ordinary scoped creation before an owned row exists", () => {
    const scoped = snapshot({ scopes: ["operator.sessions.write"] });
    const request = { method: "sessions.create", params: { agentId: "main", message: "Hello" } };
    expect(readSessionMethodAccess(scoped, request)).toMatchObject({ allowed: false });
    expect(readSessionMethodAccess(scoped, { ...request, sessionScope: true })).toEqual({
      allowed: true,
      requiredScope: "operator.sessions.write",
    });
    for (const params of [
      { incognito: true },
      { permissionMode: "full" },
      { execNode: "worker" },
      { toolOverrides: {} },
    ]) {
      expect(
        readSessionMethodAccess(scoped, { ...request, params, sessionScope: true }),
      ).toMatchObject({ allowed: false, requiredScope: "operator.admin" });
    }
  });

  it("requires admin for privileged create params", () => {
    const result = readSessionMethodAccess(snapshot({ scopes: ["operator.write"] }), {
      method: "sessions.create",
      params: { agentId: "main", incognito: true },
    });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({
      cause: "missing-scope",
      requiredScope: "operator.admin",
    });
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

  it("requires explicit opt-in and ownership for narrow session actions", () => {
    const request = { method: "sessions.patch", params: { key: "agent:main:notes", label: null } };
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

  it("rejects snapshots without advertised auth", () => {
    expect(
      readSessionMethodAccess(snapshot({ includeAuth: false }), {
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    ).toMatchObject({ allowed: false, cause: "missing-scope" });
  });

  it("rejects disconnected and unadvertised calls before scope checks", () => {
    expect(
      readSessionMethodAccess(snapshot({ connected: false }), {
        method: "sessions.create",
      }),
    ).toMatchObject({ allowed: false, cause: "disconnected" });
    expect(
      readSessionMethodAccess(snapshot({ methods: [] }), { method: "sessions.create" }),
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
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
