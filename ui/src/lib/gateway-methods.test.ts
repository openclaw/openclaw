import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import {
  canCallGatewayMethod,
  canPresentGatewayMethod,
  isGatewayMethodAdvertised,
} from "./gateway-methods.ts";

it("prepares each advertised catalog once across interleaved connections and capability refreshes", () => {
  const catalogs = ["sessions.patch", "sessions.create", "plugins.reload"].map((method) => {
    let visits = 0;
    const methods = ["health", method];
    Object.defineProperty(methods, 0, {
      get: () => {
        visits++;
        return "health";
      },
    });
    return { methods, visits: () => visits };
  });
  const first = snapshot({ methods: catalogs[0]!.methods });
  const second = snapshot({ methods: catalogs[1]!.methods });
  for (let row = 0; row < 100; row++) {
    expect(isGatewayMethodAdvertised(first, "sessions.patch")).toBe(true);
    expect(isGatewayMethodAdvertised(second, "sessions.patch")).toBe(false);
  }
  first.hello!.features = { methods: catalogs[2]!.methods };
  expect(isGatewayMethodAdvertised(first, "sessions.patch")).toBe(false);
  expect(isGatewayMethodAdvertised(first, "plugins.reload")).toBe(true);
  expect(isGatewayMethodAdvertised(second, "sessions.create")).toBe(true);
  expect(catalogs.map((catalog) => catalog.visits())).toEqual([1, 1, 1]);
});

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
  includeScopes?: boolean;
}): ApplicationGatewaySnapshot {
  const connected = params.connected ?? true;
  return createApplicationGatewaySnapshot({
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    offlineStable: !connected,
    hello: {
      auth:
        params.includeAuth === false
          ? undefined
          : {
              role: "operator",
              scopes:
                params.includeScopes === false ? undefined : (params.scopes ?? ["operator.admin"]),
            },
      features: params.methods === undefined ? {} : { methods: params.methods },
    } as ApplicationGatewaySnapshot["hello"],
    sessionKey: "agent:main:main",
  });
}

describe("canCallGatewayMethod", () => {
  it.each([
    ["operator.read.no-credential-enrollment", false],
    ["operator.write.no-credential-enrollment", true],
  ])("keeps ordinary operations available with %s, without enrollment", (scope, canWrite) => {
    const enrollment = [
      ["users.authConnect.start", "operator.write"],
      ["users.authConnect.answer", "operator.write"],
      ["users.github.authorize.start", "operator.read"],
      ["users.github.authorize.poll", "operator.read"],
    ] as const;
    const ordinary = [
      ["users.github.status", "operator.read", true],
      ["users.github.disconnect", "operator.read", true],
      ["users.authConnect.catalog", "operator.write", canWrite],
      ["users.authConnect.status", "operator.write", canWrite],
      ["users.authConnect.cancel", "operator.write", canWrite],
      ["users.selectModelAccount", "operator.write", canWrite],
      ["users.unlinkAuthProfile", "operator.write", canWrite],
    ] as const;
    const current = snapshot({
      methods: [...enrollment, ...ordinary].map(([method]) => method),
      scopes: [scope],
    });
    for (const [method, required] of enrollment) {
      expect(canCallGatewayMethod(current, method, required), method).toBe(false);
      expect(canPresentGatewayMethod(current, method, required), method).toBe(false);
    }
    for (const [method, required, allowed] of ordinary) {
      expect(canCallGatewayMethod(current, method, required), method).toBe(allowed);
    }
    const enrolled = snapshot({
      methods: enrollment.map(([method]) => method),
      scopes: [scope, "operator.write"],
    });
    for (const [method, required] of enrollment) {
      expect(canCallGatewayMethod(enrolled, method, required), method).toBe(true);
    }
  });

  it.each([
    ["models.list", "operator.read", true],
    ["chat.metadata", "operator.read", true],
    ["chat.startup", "operator.read", true],
    ["chat.history", "operator.read", true],
    ["sessions.create", "operator.write", false],
    ["chat.send", "operator.write", false],
    ["config.get", "operator.admin", false],
  ] as const)("uses the server scope for %s", (method, requestedScope, allowed) => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [method], scopes: ["operator.sessions.write"] }),
        method,
        requestedScope,
      ),
    ).toBe(allowed);
  });

  it.each([
    ["disconnected", { connected: false }],
    ["method unavailable", { methods: [], scopes: ["operator.admin"] }],
    ["scope insufficient", { methods: ["skills.update"], scopes: ["operator.write"] }],
    ["method catalog omitted", { scopes: ["operator.admin"] }],
    ["auth omitted", { methods: ["skills.update"], includeAuth: false }],
    ["scopes omitted", { methods: ["skills.update"], includeScopes: false }],
  ])("blocks %s calls", (_name, params) => {
    expect(canCallGatewayMethod(snapshot(params), "skills.update", "operator.admin")).toBe(false);
  });

  it("supports registered methods that are intentionally not advertised", () => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [], scopes: ["operator.admin"] }),
        "config.openFile",
        "operator.admin",
        { requireAdvertisement: false },
      ),
    ).toBe(true);
  });

  it.each(["connected", "reconnecting", "offline"] as const)(
    "separates retained presentation from live dispatch in %s",
    (phase) => {
      const retained = { ...snapshot({ methods: ["skills.update"] }), phase };
      expect(canPresentGatewayMethod(retained, "skills.update", "operator.admin")).toBe(true);
      expect(canCallGatewayMethod(retained, "skills.update", "operator.admin")).toBe(
        phase === "connected",
      );
    },
  );

  it.each([
    { methods: [] },
    { methods: ["skills.update"], scopes: ["operator.write"] },
    { methods: ["skills.update"], includeAuth: false },
    { methods: ["skills.update"], includeScopes: false },
  ])("does not present unadvertised or unauthorized methods (%j)", (params) => {
    expect(canPresentGatewayMethod(snapshot(params), "skills.update", "operator.admin")).toBe(
      false,
    );
  });
});
