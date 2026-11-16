import { afterEach, expect, it } from "vitest";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { MEMBER_ROLE_PRESETS } from "./member-role-presets.test-support.js";
import { linkedClaw, memoryStore, serviceFor } from "./openclaw-id.test-support.js";
import { resolveOpenClawIdTunnelPrincipal } from "./tunnel-principal.js";

afterEach(clearRuntimeConfigSnapshot);

it.each(["tunnel", "local_operator"] as const)(
  "validates set_role at the authority on %s and disconnects the member",
  async (channel) => {
    setRuntimeConfigSnapshot({ gateway: { roles: { definitions: MEMBER_ROLE_PRESETS } } });
    const claw = await linkedClaw();
    const { service, effects } = serviceFor(claw.authority);
    const peer = formatIrohEndpointKey(new Uint8Array(32).fill(21));
    try {
      await service.submitStatement(
        channel,
        await claw.sign({
          op: "add",
          account_id: "member",
          role: "operator",
          peer_keys: [peer],
          invite_id: null,
        }),
      );
      expect(
        await service.submitStatement(
          channel,
          await claw.sign({ op: "set_role", account_id: "member", role: "missing" }),
        ),
      ).toMatchObject({
        ok: false,
        code: "role_undefined",
        detail:
          "The role missing is not defined on this claw. Choose another role on the Access page.",
      });
      expect(
        await service.submitStatement(
          channel,
          await claw.sign(
            { op: "set_role", account_id: "member", role: "viewer" },
            await generateEd25519Signer(),
          ),
        ),
      ).toMatchObject({ ok: false });
      expect(await claw.authority.resolvePeer(peer)).toMatchObject({
        kind: "member",
        role: "operator",
      });
      expect(
        await service.submitStatement(
          channel,
          await claw.sign({ op: "set_role", account_id: "member", role: "viewer" }),
        ),
      ).toMatchObject({ ok: true });
      expect(await claw.authority.resolvePeer(peer)).toMatchObject({
        kind: "member",
        role: "viewer",
      });
      expect(effects.closeConnections).toHaveBeenCalledWith([`conn-${peer.slice(5, 9)}`]);
    } finally {
      await service.stop();
    }
  },
);

it("summarizes session access, required sandbox and administrator access without definitions", async () => {
  setRuntimeConfigSnapshot({
    gateway: {
      roles: {
        definitions: {
          auditor: {
            sessions: { others: "view" },
            agents: "*",
            sandbox: "required",
            scopes: ["operator.admin"],
          },
        },
      },
    },
  });
  const claw = await linkedClaw();
  const { service } = serviceFor(claw.authority);
  try {
    expect((await service.linkStatus()).roles).toEqual([
      { name: "auditor", defined: true, sessions: "view", requiresSandbox: true, admin: true },
    ]);
  } finally {
    await service.stop();
  }
});

it("commits a started role change after deletion and blocks the member's next admission", async () => {
  const base = memoryStore();
  const reached = createDeferredCore();
  const resume = createDeferredCore();
  let pause = false;
  const claw = await linkedClaw({
    ...base,
    write: async (next, assertCurrent) => {
      if (pause) {
        reached.resolve();
        await resume.promise;
      }
      await base.write(next, assertCurrent);
    },
  });
  const { service, effects } = serviceFor(claw.authority);
  const peer = formatIrohEndpointKey(new Uint8Array(32).fill(21));
  setRuntimeConfigSnapshot({ gateway: { roles: { definitions: MEMBER_ROLE_PRESETS } } });
  try {
    await service.submitStatement(
      "tunnel",
      await claw.sign({
        op: "add",
        account_id: "member",
        role: "operator",
        peer_keys: [peer],
        invite_id: null,
      }),
    );
    expect(await resolveOpenClawIdTunnelPrincipal(peer)).toMatchObject({ role: "operator" });
    const change = await claw.sign({ op: "set_role", account_id: "member", role: "viewer" });
    pause = true;
    const pending = service.submitStatement("tunnel", change);
    await reached.promise;
    setRuntimeConfigSnapshot({
      gateway: { roles: { definitions: { operator: MEMBER_ROLE_PRESETS.operator } } },
    });
    resume.resolve();
    expect(await pending).toMatchObject({ ok: true });
    expect(claw.authority.current()?.authority?.members.member?.role).toBe("viewer");
    expect((await base.read())?.authority?.members.member?.role).toBe("viewer");
    expect(effects.closeConnections).toHaveBeenCalledWith([`conn-${peer.slice(5, 9)}`]);
    expect(await resolveOpenClawIdTunnelPrincipal(peer)).toBeUndefined();
    expect((await service.linkStatus()).members).toMatchObject([
      { accountId: "member", role: "viewer", roleDefined: false },
    ]);
  } finally {
    resume.resolve();
    await service.stop();
  }
});
