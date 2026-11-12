import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "../flows/doctor-health-context.test-support.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { resolveInitialDoctorHealthContributions } from "../flows/doctor-health-contributions-initial.js";
import { writeStoredClaw, type StoredClaw } from "../gateway/openclaw-id/claw-store.js";
import { stateTest } from "../plugin-state/plugin-state-fixtures.test-support.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
// mock-isolation: Only container engine I/O is synthetic; local storage and config writes stay real.
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    ...actual,
    spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) =>
      ["docker", "podman"].includes(args[0][0]!)
        ? spawnCommand(...args)
        : actual.spawnCommand(...args),
  };
});
const it = stateTest("doctor-member-roles");
beforeEach(() => {
  spawnCommand.mockReset().mockRejectedValue(new Error("synthetic engine unavailable"));
});
afterEach(() => vi.restoreAllMocks());
const viewer: GatewayOperatorRoleDefinition = {
  sessions: { others: "view" as const },
  agents: "*" as const,
  scopes: ["operator.sessions.read"],
};
const definitions = {
  operator: viewer,
  viewer,
  guest: { ...viewer, sandbox: "required" as const },
};
const cfg = (enabled = true): OpenClawConfig => ({
  gateway: { openclawId: { enabled }, roles: { definitions } },
});

function contribution() {
  const noop = async () => {};
  const result = resolveInitialDoctorHealthContributions({
    runStructuredHealthRepairs: noop,
    runGatewayConfigHealth: noop,
    runAuthProfileMigration: noop,
    runAuthProfileHealth: noop,
    runGatewayAuthHealth: noop,
    runLegacyStateHealth: noop,
  }).find(({ id }) => id === "doctor:sandbox");
  expect(
    result?.healthChecks.find(({ id }) => id === "core/doctor/member-roles"),
    "member-role checks must be registered in Doctor",
  ).toBeDefined();
  return result!;
}
function claw(members: Record<string, string>): StoredClaw {
  return {
    v: 1,
    claw_id: "0".repeat(32),
    hostname: null,
    binding: null,
    authority: {
      claw_id: "0".repeat(32),
      anchor: { root_pub: `ed25519:${"1".repeat(64)}` },
      seq: 1,
      owner_devices: {},
      invites: {},
      nodes: {},
      node_invites: {},
      members: Object.fromEntries(
        Object.entries(members).map(([account, role]) => [
          account,
          { role, peer_keys: [], listed_seq: [], last_seen: {} },
        ]),
      ),
    },
    discovery: {
      owner_account_id: null,
      published_binding_seq: 0,
      published_snapshot_seq: 0,
      mailbox_cursor: null,
    },
  };
}
async function detect(config: OpenClawConfig) {
  return contribution()
    .healthChecks.find(({ id }) => id === "core/doctor/member-roles")!
    .detect({
      mode: "doctor",
      cfg: config,
      runtime: { log() {}, error() {}, exit() {} },
    });
}

it("reads every undefined member role from the local claw with the Gateway stopped", async ({
  state,
}) => {
  state.applyEnv();
  await writeStoredClaw(claw({ alice: "researcher", bob: "retired", carol: "viewer" }));
  await closeOpenClawStateDatabaseAsync();
  const findings = await detect(cfg());
  expect(findings.map(({ message }) => message)).toEqual([
    expect.stringMatching(/alice.*researcher.*cannot connect/),
    expect.stringMatching(/bob.*retired.*cannot connect/),
  ]);
  expect(
    findings.every(
      ({ fixHint }) => fixHint?.includes("gateway.roles.definitions") && fixHint.includes("Access"),
    ),
  ).toBe(true);
  expect(spawnCommand).not.toHaveBeenCalled();
});

it("reports missing and incomplete local membership instead of passing silently", async ({
  state,
}) => {
  state.applyEnv();
  expect(await detect(cfg())).toEqual([
    expect.objectContaining({ requirement: "membership-unreadable" }),
  ]);
  await writeStoredClaw(claw({ alice: "viewer" }));
  await createCorePluginStateKeyedStore({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  }).delete("members");
  expect(await detect(cfg())).toEqual([
    expect.objectContaining({
      requirement: "membership-unreadable",
      message: expect.stringContaining("missing members"),
    }),
  ]);
});

for (const enabled of [false, true]) {
  it(`preserves no-roles Doctor output even with OpenClaw ID enabled=${enabled}`, async ({
    state,
  }) => {
    state.applyEnv();
    expect(await detect({ gateway: { openclawId: { enabled } } })).toEqual([]);
    expect(spawnCommand).not.toHaveBeenCalled();
  });
}
it("preserves default-set, OpenClaw-ID-off output even for a required sandbox", async ({
  state,
}) => {
  state.applyEnv();
  const config = cfg(false);
  config.gateway!.roles!.default = "guest";
  expect(await detect(config)).toEqual([]);
  expect(spawnCommand).not.toHaveBeenCalled();
});

for (const who of ["member", "default"]) {
  it(`warns when a ${who} requires an unavailable sandbox, even with agent mode off`, async ({
    state,
  }) => {
    state.applyEnv();
    await writeStoredClaw(claw(who === "member" ? { alice: "guest" } : {}));
    const config = cfg();
    config.agents = { defaults: { sandbox: { mode: "off" } } };
    if (who === "default") {
      config.gateway!.roles!.default = "guest";
    }
    const findings = await detect(config);
    expect(findings).toEqual([
      expect.objectContaining({
        requirement: "sandbox-unavailable",
        message: expect.stringMatching(
          who === "member" ? /alice.*guest.*runs will fail/ : /default.*guest.*runs will fail/,
        ),
        fixHint: expect.stringContaining("Docker"),
      }),
    ]);
    expect(spawnCommand).toHaveBeenCalled();
    spawnCommand.mockResolvedValue({
      failed: false,
      isCanceled: false,
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(await detect(config)).toEqual([]);
  });
}
it("does not warn for unused required roles or an unprobed non-container backend", async ({
  state,
}) => {
  state.applyEnv();
  await writeStoredClaw(claw({ alice: "viewer" }));
  expect(await detect(cfg())).toEqual([]);
  expect(spawnCommand).not.toHaveBeenCalled();
  await writeStoredClaw(claw({ alice: "guest" }));
  const config = cfg();
  config.agents = { defaults: { sandbox: { backend: "ssh" } } };
  expect(await detect(config)).toEqual([]);
  expect(spawnCommand).not.toHaveBeenCalled();
});

it("warns about stored assignments only when the named default is absent", async ({ state }) => {
  state.applyEnv();
  const profile = ensureProfileForEmail("alice@example.test");
  setUserProfileRole(profile.id, "viewer");
  await closeOpenClawStateDatabaseAsync();
  expect(await detect(cfg(false))).toEqual([
    expect.objectContaining({
      requirement: "assignments-inactive",
      message: expect.stringMatching(/enforcement is off.*assignments have no effect/),
    }),
  ]);
  const config = cfg(false);
  config.gateway!.roles!.default = "viewer";
  expect(await detect(config)).toEqual([]);
});

for (const accepted of [false, true]) {
  it(`offers missing presets and persists only after acceptance=${accepted}`, async ({ state }) => {
    state.applyEnv();
    await writeStoredClaw(claw({ alice: "viewer" }));
    const config = cfg();
    config.gateway!.roles = { definitions: { operator: viewer, custom: viewer } };
    await state.writeConfig(config);
    const original = `// keep until accepted\n${await fs.readFile(state.configPath, "utf8")}`;
    await fs.writeFile(state.configPath, original);
    const snapshot = await readConfigFileSnapshot({ observe: false });
    const ctx = createDoctorHealthFlowContext({
      cfg: config,
      env: state.env,
      configPath: state.configPath,
      prompter: createDoctorPrompterFixture(accepted),
      configResult: { confirmedConfigSource: { path: snapshot.path, hash: snapshot.hash! } },
    });
    const check = contribution();
    const findings = await check.healthChecks
      .find(({ id }) => id === "core/doctor/member-roles")!
      .detect({
        mode: "lint",
        cfg: config,
        runtime: ctx.runtime,
      });
    expect(
      findings
        .filter(({ requirement }) => requirement === "missing-preset")
        .map(({ target }) => target),
    ).toEqual(["guest", "viewer"]);
    await check.run(ctx);
    expect(ctx.prompter.confirmAutoFix).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/JSON.*comments.*removed/),
        initialValue: false,
      }),
    );
    if (!accepted) {
      expect(ctx.cfg).toBe(config);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      return;
    }
    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    const saved = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    expect(saved.gateway?.roles).toEqual({
      definitions: {
        operator: viewer,
        custom: viewer,
        viewer,
        guest: {
          sessions: { others: "view" },
          agents: "*",
          scopes: ["operator.sessions.write"],
          sandbox: "required",
        },
      },
    });
  });
}
