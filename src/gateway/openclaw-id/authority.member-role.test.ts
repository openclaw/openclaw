import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { MEMBER_ROLE_PRESETS } from "./member-role-presets.test-support.js";
import { linkedClaw, memoryStore, ownerInvite, serviceFor } from "./openclaw-id.test-support.js";
import { resolveOpenClawIdTunnelPrincipal } from "./tunnel-principal.js";

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
// mock-isolation: container engine I/O is synthetic; config, authority and storage stay real.
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand,
}));
let sandboxImage: "present" | "missing" = "present";
beforeEach(() => {
  sandboxImage = "present";
  spawnCommand.mockReset().mockImplementation(async (argv: string[]) => {
    const missing = sandboxImage === "missing" && argv.includes("inspect");
    return {
      failed: missing,
      isCanceled: false,
      exitCode: missing ? 1 : 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(missing ? "Error: No such image: openclaw-sandbox:trixie-slim" : ""),
    };
  });
});
afterEach(clearRuntimeConfigSnapshot);

it.each(["tunnel", "local_operator"] as const)(
  "refuses inviting or moving anyone to a sandbox role whose image is missing on %s",
  async (channel) => {
    setRuntimeConfigSnapshot({ gateway: { roles: { definitions: MEMBER_ROLE_PRESETS } } });
    sandboxImage = "missing";
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const peer = formatIrohEndpointKey(new Uint8Array(32).fill(22));
    const refusal = {
      ok: false,
      code: "sandbox_unavailable",
      detail:
        "The guest role requires a sandbox, but its sandbox image openclaw-sandbox:trixie-slim is missing on this claw. Set up sandboxing, then try again.",
    };
    try {
      const invite = await ownerInvite(claw, { email: "guest@example.test", role: "guest" });
      expect(
        await service.registerInvite(channel, { cap: invite.cap, proofKey: invite.proofKey }),
      ).toEqual(refusal);
      expect((await claw.authority.load())?.authority?.invites).toEqual({});
      await service.submitStatement(
        channel,
        await claw.sign({
          op: "add",
          account_id: "member",
          role: "viewer",
          peer_keys: [peer],
          invite_id: null,
        }),
      );
      // A forged grant is refused on its signature before any engine probe runs.
      spawnCommand.mockClear();
      expect(
        await service.submitStatement(
          channel,
          await claw.sign(
            { op: "set_role", account_id: "member", role: "guest" },
            await generateEd25519Signer(),
          ),
        ),
      ).toMatchObject({ ok: false, code: expect.not.stringMatching("sandbox_unavailable") });
      expect(spawnCommand).not.toHaveBeenCalled();
      const moveToGuest = await claw.sign({ op: "set_role", account_id: "member", role: "guest" });
      expect(await service.submitStatement(channel, moveToGuest)).toEqual(refusal);
      expect(await claw.authority.resolvePeer(peer)).toMatchObject({ role: "viewer" });

      sandboxImage = "present";
      expect(
        await service.registerInvite(channel, { cap: invite.cap, proofKey: invite.proofKey }),
      ).toMatchObject({ ok: true });
      expect(await service.submitStatement(channel, moveToGuest)).toMatchObject({ ok: true });
      expect(await claw.authority.resolvePeer(peer)).toMatchObject({ role: "guest" });
    } finally {
      await service.stop();
    }
  },
);

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

it.each(["initial load", "queued import"])(
  "does not publish member-role initialization after ID disables during %s",
  async (operation) => {
    const base = memoryStore();
    const claw = await linkedClaw(base);
    const peer = formatIrohEndpointKey(new Uint8Array(32).fill(21));
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "member",
          role: "operator",
          peer_keys: [peer],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    const stored = (await base.read())!;
    delete stored.member_profile_roles;
    await base.write(stored);
    const reached = createDeferredCore();
    const resume = createDeferredCore();
    let enabled = operation === "initial load";
    let pause = true;
    const owner = createOpenClawIdAuthority(
      {
        ...base,
        async write(next, assertCurrent) {
          if (pause && next.member_profile_roles?.member) {
            reached.resolve();
            await resume.promise;
          }
          await base.write(next, assertCurrent);
        },
      },
      () => enabled,
    );
    try {
      if (operation === "queued import") {
        await owner.load();
        enabled = true;
      }
      const pending =
        operation === "initial load" ? owner.load() : owner.initializeMemberProfileRoles();
      await reached.promise;
      enabled = false;
      const rejected = expect(pending).rejects.toThrow("member role import changed");
      resume.resolve();
      await rejected;
      expect((await base.read())?.member_profile_roles).toBeUndefined();
      expect((await owner.load())?.member_profile_roles).toBeUndefined();
      enabled = true;
      pause = false;
      await owner.initializeMemberProfileRoles();
      expect((await base.read())?.member_profile_roles).toEqual({ member: true });
      expect(owner.current()?.member_profile_roles).toEqual({ member: true });
    } finally {
      resume.resolve();
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

it("commits a started profile role change after deletion and reports its undefined label", async () => {
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
    expect(await resolveOpenClawIdTunnelPrincipal(peer)).toMatchObject({ kind: "member" });
    expect((await service.linkStatus()).members).toMatchObject([
      { accountId: "member", role: "viewer", roleDefined: false },
    ]);
  } finally {
    resume.resolve();
    await service.stop();
  }
});
