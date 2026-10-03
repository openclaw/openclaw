import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { GatewayClient } from "./server-methods/client-types.js";

// Keep both real module instances alive, as source and built runtime graphs can be.
const issuer = await import("../agents/admitted-run-context.js");
vi.resetModules();
const consumer = await import("./operator-run-authority.js");
const reloadedIssuer = await import("../agents/admitted-run-context.js");

function inherit(authority: AdmittedRunOperatorAuthority, scopes: string[]) {
  const client: GatewayClient = {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
    internal: { operatorRunAuthority: authority },
  };
  return consumer.captureGatewayOperatorRunAuthority({
    client,
    context: { getRuntimeConfig: () => ({}) },
  });
}

it.each(["source assertion", "abort"] as const)(
  "inherits authority across module instances without losing %s revocation",
  async (revocation) => {
    expect(issuer.createAdmittedRunOperatorAuthority).not.toBe(
      reloadedIssuer.createAdmittedRunOperatorAuthority,
    );
    const controller = new AbortController();
    const failure = new Error("original source retired");
    let current = true;
    let holds = 0;
    const original = issuer.createAdmittedRunOperatorAuthority({
      profileId: "module-owner",
      scopes: ["operator.read", "operator.write"],
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) {
          throw failure;
        }
      },
      retain: () => {
        holds += 1;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            holds -= 1;
          }
        };
      },
    });
    const inherited = await inherit(original, ["operator.read", "operator.write"]);
    const narrowed = await inherit(original, ["operator.read"]);
    try {
      expect(inherited?.authority).toBe(original);
      expect(narrowed?.authority).not.toBe(original);
      expect(narrowed?.authority.scopes).toEqual(["operator.read"]);
      expect(narrowed?.authority.source).toBe(original.source);
      expect(narrowed?.authority.signal).toBe(controller.signal);
      expect(holds).toBe(2);
      expect(() => narrowed?.authority.assertCurrent()).not.toThrow();

      inherited?.release();
      inherited?.release();
      expect(holds).toBe(1);
      expect(() => narrowed?.authority.assertCurrent()).not.toThrow();
      if (revocation === "abort") {
        controller.abort(failure);
      } else {
        current = false;
      }
      expect(() => narrowed?.authority.assertCurrent()).toThrow(failure);
      current = true;
      await expect(inherit(original, ["operator.read"])).rejects.toBe(failure);
      // Issuance is provenance, not permission to use a retired source.
      expect(() => reloadedIssuer.assertAdmittedRunOperatorAuthority(original)).not.toThrow();
      expect(holds).toBe(1);
    } finally {
      narrowed?.release();
      inherited?.release();
    }
    expect(holds).toBe(0);
  },
);

it.each(["unissued", "spread", "json"] as const)(
  "rejects %s authority at the inherited consumer before invoking its callbacks",
  async (copy) => {
    const assertCurrent = vi.fn();
    const retain = vi.fn(() => () => {});
    const source = { profileId: "module-owner", scopes: ["operator.read"], assertCurrent, retain };
    const issued = issuer.createAdmittedRunOperatorAuthority(source);
    const unissued: AdmittedRunOperatorAuthority =
      copy === "unissued"
        ? source
        : copy === "spread"
          ? { ...issued }
          : // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON serialization must not preserve host provenance
            JSON.parse(JSON.stringify(issued));
    await expect(inherit(unissued, ["operator.read"])).rejects.toThrow(
      "operator run authority must be issued by the host",
    );
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
  },
);
