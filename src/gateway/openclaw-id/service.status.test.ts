import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatIrohEndpointKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
// mock-isolation: engine process I/O is synthetic; config and target selection remain real.
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand,
}));
beforeEach(() => {
  spawnCommand.mockReset().mockResolvedValue({
    failed: false,
    isCanceled: false,
    exitCode: 0,
    stdout: Buffer.from("true\tfalse\t\t5.0.0\n"),
    stderr: Buffer.alloc(0),
  });
});
afterEach(clearRuntimeConfigSnapshot);

describe("OpenClaw ID link status", () => {
  it("rejects oversized Discovery metadata without blocking later authority writes", async () => {
    const claw = await linkedClaw();
    for (const field of ["owner_account_id", "mailbox_cursor"] as const) {
      await expect(
        claw.authority.recordDiscovery({ [field]: "\u0001".repeat(257) }),
      ).rejects.toThrow("at most 256");
    }
    await expect(
      claw.authority.recordVerifiedAccount({
        sub: "x".repeat(257),
        name: null,
        email: null,
        exp: 1,
      }),
    ).rejects.toThrow("at most 256");
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "member",
          role: "viewer",
          peer_keys: [formatIrohEndpointKey(new Uint8Array(32).fill(12))],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    // A normal persisted update still commits after the rejected remote metadata.
    await claw.authority.recordDiscovery({ mailbox_cursor: "unchanged-authority" });
    expect(claw.authority.current()?.discovery.mailbox_cursor).toBe("unchanged-authority");
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(claw.w1);
  });

  it("is unpublished until the claw is registered with Discovery", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    expect((await service.linkStatus()).publication).toBeUndefined();
  });

  it("reports the recorded publication after a restart, before any new attempt", async () => {
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({
      owner_account_id: "acct-owner",
      published_binding_seq: 1,
      published_snapshot_seq: 4,
    });
    const { service } = serviceFor(claw.authority);
    expect((await service.linkStatus()).publication).toEqual({
      state: "published",
      ownerAccountId: "acct-owner",
      snapshotSeq: 4,
      snapshotIssuedAt: 0,
    });
  });
});

it("exposes configured and undefined member roles without replacing their opaque names", async () => {
  const claw = await linkedClaw();
  for (const [account, role, byte] of [
    ["custom", "guest", 13],
    ["deleted", "removed-role", 14],
  ] as const) {
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: account,
        role,
        peer_keys: [formatIrohEndpointKey(new Uint8Array(32).fill(byte))],
        invite_id: null,
      }),
      "tunnel",
    );
  }
  setRuntimeConfigSnapshot({
    gateway: {
      roles: {
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.sessions.read"],
            sandbox: "required",
          },
          operator: { sessions: { others: "write" }, agents: "*", scopes: [] },
          viewer: { sessions: { others: "view" }, agents: "*", scopes: [], sandbox: "inherit" },
        },
      },
    },
  });
  const { service } = serviceFor(claw.authority);
  try {
    const status = await service.linkStatus();
    expect(status).toMatchObject({
      roles: [
        { name: "guest", defined: true, requiresSandbox: true },
        { name: "operator", defined: true, requiresSandbox: false },
        { name: "removed-role", defined: false, requiresSandbox: false },
        { name: "viewer", defined: true, requiresSandbox: false },
      ],
      members: [
        { role: "guest", roleDefined: true },
        { role: "removed-role", roleDefined: false },
      ],
    });
  } finally {
    await service.stop();
    clearRuntimeConfigSnapshot();
  }
});

it.each(["docker", "podman"])(
  "reports fresh %s engine usability even when sandbox mode is off",
  async (backend) => {
    setRuntimeConfigSnapshot({ agents: { defaults: { sandbox: { backend, mode: "off" } } } });
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    try {
      expect(await service.linkStatus({ includeSandboxBackend: true })).toMatchObject({
        sandboxBackend: { backend, available: true },
      });
      expect(spawnCommand.mock.calls.every(([argv]) => argv.includes(backend))).toBe(true);
      expect(spawnCommand.mock.calls.some(([argv]) => argv.includes("info"))).toBe(true);
      spawnCommand.mockRejectedValue(new Error("synthetic daemon unavailable"));
      expect(await service.linkStatus({ includeSandboxBackend: true })).toMatchObject({
        sandboxBackend: { backend, available: false },
      });
    } finally {
      await service.stop();
    }
  },
);

it.each(["missing executable", "daemon permission denied", "daemon stopped"])(
  "reports the default Docker backend unavailable for %s without probing another engine",
  async (failure) => {
    if (failure === "daemon stopped") {
      spawnCommand.mockResolvedValue({
        failed: true,
        isCanceled: false,
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("Cannot connect to the Docker daemon"),
      });
    } else {
      spawnCommand.mockRejectedValue(
        Object.assign(new Error(failure), {
          code: failure === "missing executable" ? "ENOENT" : "EACCES",
        }),
      );
    }
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    try {
      expect(await service.linkStatus({ includeSandboxBackend: true })).toMatchObject({
        sandboxBackend: { backend: "docker", available: false },
      });
      expect(spawnCommand).toHaveBeenCalledOnce();
      expect(spawnCommand.mock.calls[0]?.[0]).toEqual(["docker", "info"]);
    } finally {
      await service.stop();
    }
  },
);

it("leaves non-container backend availability unknown without probing Docker", async () => {
  setRuntimeConfigSnapshot({ agents: { defaults: { sandbox: { backend: "ssh" } } } });
  const claw = await linkedClaw();
  const { service } = serviceFor(claw.authority);
  try {
    expect(await service.linkStatus({ includeSandboxBackend: true })).toMatchObject({
      sandboxBackend: { backend: "ssh", available: null },
    });
    expect(spawnCommand).not.toHaveBeenCalled();
  } finally {
    await service.stop();
  }
});

it("does not probe engines or load authority when OpenClaw ID is disabled", async () => {
  const { createOpenClawIdService } = await import("./service.js");
  const createAuthority = vi.fn();
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: false }),
    getStateDir: () => "/nonexistent/openclaw-id-disabled-test",
    getGatewayServer: () => undefined,
    createAuthority,
    log: { info() {}, warn() {} },
  });
  expect(await service.linkStatus({ includeSandboxBackend: true })).toEqual({
    linked: false,
    publication: undefined,
  });
  expect(createAuthority).not.toHaveBeenCalled();
  expect(spawnCommand).not.toHaveBeenCalled();
  await service.stop();
});

it("keeps ordinary owner authority reads independent of sandbox engine probes", async () => {
  spawnCommand.mockRejectedValue(new Error("engine must not participate in owner authorization"));
  const claw = await linkedClaw();
  const { service } = serviceFor(claw.authority);
  try {
    expect(await service.linkStatus()).toMatchObject({ linked: true });
    expect(spawnCommand.mock.calls.length).toBe(0);
  } finally {
    await service.stop();
  }
});
