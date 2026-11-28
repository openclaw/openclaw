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
            sessions: { others: "invited", maxInvitedAccess: "send" },
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
        { name: "guest", defined: true, requiresSandbox: true, maxInvitedAccess: "send" },
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

const guestRole = {
  sessions: { others: "view" as const },
  agents: "*" as const,
  scopes: ["operator.sessions.read" as const],
  sandbox: "required" as const,
};
const sandboxConfig = (sandbox: Record<string, unknown>) => ({
  agents: { defaults: { sandbox } },
  gateway: {
    roles: {
      definitions: {
        guest: guestRole,
        operator: { sessions: { others: "write" as const }, agents: "*" as const, scopes: [] },
      },
    },
  },
});
const engineReply = (failed: boolean, stderr = "") => ({
  failed,
  isCanceled: false,
  exitCode: failed ? 1 : 0,
  stdout: Buffer.from("true\tfalse\t\t5.0.0\n"),
  stderr: Buffer.from(stderr),
});
const guestReadiness = async (sandbox: Record<string, unknown>) => {
  setRuntimeConfigSnapshot(sandboxConfig(sandbox));
  const claw = await linkedClaw();
  const { service } = serviceFor(claw.authority);
  try {
    const status = await service.linkStatus({ includeSandboxReadiness: true });
    return status.linked ? status.roles.find((role) => role.name === "guest") : undefined;
  } finally {
    await service.stop();
  }
};

it.each(["docker", "podman"])(
  "reports whether the %s sandbox image for a required-sandbox role exists, even with mode off",
  async (backend) => {
    expect(await guestReadiness({ backend, mode: "off" })).toMatchObject({
      requiresSandbox: true,
      sandbox: { ready: true },
    });
    expect(spawnCommand.mock.calls.every(([argv]) => argv.includes(backend))).toBe(true);
    expect(spawnCommand.mock.calls.some(([argv]) => argv.includes("info"))).toBe(true);
    expect(
      spawnCommand.mock.calls.some(([argv]) =>
        argv.join(" ").includes("image inspect openclaw-sandbox:trixie-slim"),
      ),
    ).toBe(true);
    spawnCommand.mockImplementation(async (argv: string[]) =>
      argv.includes("inspect")
        ? engineReply(true, "Error: No such image: openclaw-sandbox:trixie-slim")
        : engineReply(false),
    );
    expect(await guestReadiness({ backend, mode: "off" })).toMatchObject({
      sandbox: {
        ready: false,
        reason: "image_missing",
        backend,
        image: "openclaw-sandbox:trixie-slim",
        doctorBuilds: backend === "docker",
      },
    });
    spawnCommand.mockRejectedValue(new Error("synthetic daemon unavailable"));
    expect(await guestReadiness({ backend, mode: "off" })).toMatchObject({
      sandbox: { ready: false, reason: "engine_unavailable", backend },
    });
  },
);

it("checks each agent's own sandbox image and leaves roles without a sandbox unprobed", async () => {
  spawnCommand.mockImplementation(async (argv: string[]) =>
    argv.includes("custom/sandbox:1")
      ? engineReply(true, "Error: No such image: custom/sandbox:1")
      : engineReply(false),
  );
  const config = sandboxConfig({});
  setRuntimeConfigSnapshot({
    ...config,
    agents: {
      entries: {
        main: {},
        research: { sandbox: { docker: { image: "custom/sandbox:1" } } },
      },
    },
  });
  const claw = await linkedClaw();
  const { service } = serviceFor(claw.authority);
  try {
    const status = await service.linkStatus({ includeSandboxReadiness: true });
    expect(status).toMatchObject({
      roles: [
        {
          name: "guest",
          sandbox: {
            ready: false,
            reason: "image_missing",
            image: "custom/sandbox:1",
            doctorBuilds: false,
          },
        },
        { name: "operator", requiresSandbox: false },
      ],
    });
    const operator = status.linked
      ? status.roles.find((role) => role.name === "operator")
      : undefined;
    expect(operator?.defined ? operator.sandbox : "undefined role").toBeUndefined();
  } finally {
    await service.stop();
  }
});

it("names Doctor only for the image Doctor builds", async () => {
  spawnCommand.mockImplementation(async (argv: string[]) =>
    argv.includes("openclaw-sandbox:trixie-slim")
      ? engineReply(true, "Error: No such image: openclaw-sandbox:trixie-slim")
      : engineReply(false),
  );
  setRuntimeConfigSnapshot({
    ...sandboxConfig({ docker: { image: "custom/sandbox:1" } }),
    agents: {
      defaults: { sandbox: { docker: { image: "custom/sandbox:1" } } },
      entries: {
        main: { sandbox: { docker: { image: "openclaw-sandbox:trixie-slim" } } },
      },
    },
  });
  const claw = await linkedClaw();
  const { service } = serviceFor(claw.authority);
  try {
    // Doctor checks the defaults' custom image, so it would not build this agent's image.
    expect(await service.linkStatus({ includeSandboxReadiness: true })).toMatchObject({
      roles: [
        {
          name: "guest",
          sandbox: {
            reason: "image_missing",
            image: "openclaw-sandbox:trixie-slim",
            doctorBuilds: false,
          },
        },
        { name: "operator" },
      ],
    });
  } finally {
    await service.stop();
  }
});

it("leaves non-container backend readiness unknown without probing Docker", async () => {
  expect(await guestReadiness({ backend: "ssh" })).toMatchObject({
    sandbox: { ready: null, backend: "ssh" },
  });
  expect(spawnCommand).not.toHaveBeenCalled();
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
  expect(await service.linkStatus({ includeSandboxReadiness: true })).toEqual({
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
