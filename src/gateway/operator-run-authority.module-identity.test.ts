import { expect, it, vi } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";

const { createAdmittedRunOperatorAuthority: issue } =
  await import("../agents/admitted-run-context.js");
vi.resetModules();
const consumer = await import("./operator-run-authority.js");
const reloadedIssuer = await import("../agents/admitted-run-context.js");

function inherit(authority: AdmittedRunOperatorAuthority, scopes: string[]) {
  const connect = createOperatorClient({ profileId: "module-owner", scopes }).connect;
  return consumer.captureGatewayOperatorRunAuthority({
    client: { connect, internal: { operatorRunAuthority: authority } },
    context: { getRuntimeConfig: () => ({}) },
  });
}

it.each(["assertion", "abort"] as const)(
  "preserves %s revocation across modules",
  async (revocation) => {
    expect(issue).not.toBe(reloadedIssuer.createAdmittedRunOperatorAuthority);
    const controller = new AbortController();
    const failure = new Error("original source retired");
    let current = true;
    let holds = 0;
    const original = issue({
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
        return vi.fn().mockImplementationOnce(() => {
          holds -= 1;
        });
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
      expect(() => reloadedIssuer.assertAdmittedRunOperatorAuthority(original)).not.toThrow();
      expect(holds).toBe(1);
    } finally {
      narrowed?.release();
      inherited?.release();
    }
    expect(holds).toBe(0);
  },
);

it.each(["unissued", "spread", "json"] as const)("rejects %s before callbacks", async (copy) => {
  const [assertCurrent, retain] = [vi.fn(), vi.fn(() => () => {})] as const;
  const source = { profileId: "module-owner", scopes: ["operator.read"], assertCurrent, retain };
  const issued = issue(source);
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
  expect([assertCurrent.mock.calls, retain.mock.calls]).toEqual([[], []]);
});
