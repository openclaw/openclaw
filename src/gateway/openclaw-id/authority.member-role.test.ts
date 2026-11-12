import { afterEach, expect, it } from "vitest";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { MEMBER_ROLE_PRESETS } from "./member-role-presets.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

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
