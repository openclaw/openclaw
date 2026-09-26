import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { readSessionMethodAccess } from "./session-method-access.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
  includeScopes?: boolean;
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
              ...(params.includeScopes === false
                ? {}
                : { scopes: params.scopes ?? ["operator.write"] }),
            },
          }),
    } as ApplicationGatewaySnapshot["hello"],
  };
}

describe("readSessionMethodAccess", () => {
  it("allows a write-scoped operator to create ordinary sessions", () => {
    expect(
      readSessionMethodAccess(snapshot({}), {
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
  });

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
    const access = readSessionMethodAccess(snapshot({ scopes: ["operator.write"] }), {
      method: "sessions.create",
      params: { agentId: "main", incognito: true },
    });
    expect(access.allowed).toBe(false);
    expect(access).toMatchObject({
      cause: "missing-scope",
      requiredScope: "operator.admin",
    });
  });

  it("allows write-scoped device placement through the caller's scope", () => {
    const method = "sessions.dispatch";
    expect(
      readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.write"] }), {
        method,
        params: { key: "agent:main:device", deviceId: "runner" },
        requiredScope: "operator.write",
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
  });

  it("keeps profile placement admin-only through the caller's scope", () => {
    const method = "sessions.dispatch";
    const params = { key: "agent:main:cloud", profileId: "aws" };
    expect(
      readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.write"] }), {
        method,
        params,
        requiredScope: "operator.admin",
      }),
    ).toMatchObject({ allowed: false, requiredScope: "operator.admin" });
    expect(
      readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.admin"] }), {
        method,
        params,
        requiredScope: "operator.admin",
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.admin" });
  });

  it.each(["model", "thinkingLevel", "fastMode"])(
    "allows write-scoped %s changes while keeping read-only clients read-only",
    (field) => {
      for (const scope of [
        "operator.read",
        "operator.sessions.read",
        "operator.sessions.write",
        "operator.write",
        "operator.admin",
      ]) {
        expect(
          readSessionMethodAccess(snapshot({ methods: ["sessions.patch"], scopes: [scope] }), {
            method: "sessions.patch",
            params: { key: "agent:main:main", [field]: null },
          }),
        ).toMatchObject({
          allowed: scope === "operator.write" || scope === "operator.admin",
          requiredScope: "operator.write",
        });
      }
    },
  );

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
      readSessionMethodAccess(snapshot({ methods: [request.method], scopes: ["operator.write"] }), {
        ...request,
        sessionScope: true,
        session: { sharingRole: "viewer" },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.sessions.write" });
  });

  it("keeps context-window changes separate from write-scoped effort access", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["sessions.patch"], scopes: ["operator.write"] }),
        {
          method: "sessions.patch",
          params: { key: "agent:main:main", contextWindow: null },
        },
      ),
    ).toMatchObject({ allowed: false, cause: "missing-scope", requiredScope: "operator.admin" });
  });

  it("allows admin to satisfy write-scoped actions", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["sessions.groups.put"], scopes: ["operator.admin"] }),
        { method: "sessions.groups.put", requiredScope: "operator.write" },
      ).allowed,
    ).toBe(true);
  });

  it("allows read, write, and admin scopes to satisfy read-scoped actions", () => {
    for (const method of ["session.members.list", "session.members.listEvidence"]) {
      for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
        expect(
          readSessionMethodAccess(snapshot({ methods: [method], scopes: [scope] }), {
            method,
            requiredScope: "operator.read",
          }).allowed,
        ).toBe(true);
      }
    }
  });

  it("rejects a read-scoped action without a compatible operator scope", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["session.members.listEvidence"], scopes: ["operator.approvals"] }),
        { method: "session.members.listEvidence", requiredScope: "operator.read" },
      ),
    ).toMatchObject({
      allowed: false,
      cause: "missing-scope",
      requiredScope: "operator.read",
    });
  });

  it.each([
    ["auth", { includeAuth: false }],
    ["scopes", { includeScopes: false }],
  ])("rejects snapshots without advertised %s", (_name, params) => {
    expect(
      readSessionMethodAccess(snapshot(params), {
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
