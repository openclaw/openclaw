import { afterEach, expect, it } from "vitest";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { wrapPluginStateError } from "../../plugin-state/plugin-state-store.database.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { MEMBER_ROLE_PRESETS } from "./member-role-presets.js";
import { linkedClaw, memoryStore, serviceFor } from "./openclaw-id.test-support.js";

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
      ).toMatchObject({ ok: false, code: "role_undefined" });
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

it.each([false, true])(
  "refuses a role deleted while storage is waiting without changing membership (wrapped=%s)",
  async (wrapped) => {
    const base = memoryStore();
    const reached = createDeferredCore();
    const resume = createDeferredCore();
    let pause = false;
    const claw = await linkedClaw({
      ...base,
      write: async (next, assertCurrent?: () => void) => {
        if (pause) {
          reached.resolve();
          await resume.promise;
        }
        try {
          assertCurrent?.();
        } catch (error) {
          throw wrapped
            ? wrapPluginStateError(
                error,
                "register",
                "PLUGIN_STATE_WRITE_FAILED",
                "Failed to write state.",
                "/private/example.sqlite",
              )
            : error;
        }
        await base.write(next);
      },
    });
    setRuntimeConfigSnapshot({ gateway: { roles: { definitions: MEMBER_ROLE_PRESETS } } });
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "member",
        role: "operator",
        peer_keys: [formatIrohEndpointKey(new Uint8Array(32).fill(21))],
        invite_id: null,
      }),
      "tunnel",
    );
    const change = await claw.sign({ op: "set_role", account_id: "member", role: "viewer" });
    pause = true;
    const pending = claw.authority.submit(change, "tunnel");
    await reached.promise;
    setRuntimeConfigSnapshot({
      gateway: { roles: { definitions: { operator: MEMBER_ROLE_PRESETS.operator } } },
    });
    resume.resolve();
    expect(await pending).toEqual({
      ok: false,
      code: "role_undefined",
      detail:
        "The role viewer is not defined on this claw. Choose another role on the Access page.",
    });
    expect(claw.authority.current()?.authority?.members.member?.role).toBe("operator");
    expect((await base.read())?.authority?.members.member?.role).toBe("operator");
  },
);
