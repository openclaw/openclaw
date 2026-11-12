import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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

it("does not warn for a fresh enabled install or an unlinked claw", async ({ state }) => {
  state.applyEnv();
  expect(await detect(cfg())).toEqual([]);
  await writeStoredClaw({ ...claw({}), authority: null });
  expect(await detect(cfg())).toEqual([]);
});

const clawStore = () =>
  createCorePluginStateKeyedStore<unknown>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  });

it("reports incomplete local membership instead of passing silently", async ({ state }) => {
  state.applyEnv();
  await writeStoredClaw(claw({ alice: "viewer" }));
  await clawStore().delete("members");
  expect(await detect(cfg())).toEqual([
    expect.objectContaining({
      requirement: "membership-unreadable",
      message: "Doctor could not read OpenClaw ID membership from the local claw record.",
      fixHint: expect.stringContaining("Access"),
    }),
  ]);
});

for (const members of [null, [], 42]) {
  it(`reports a malformed member collection: ${JSON.stringify(members)}`, async ({ state }) => {
    state.applyEnv();
    await writeStoredClaw(claw({ alice: "undefined-role" }));
    await clawStore().register("members", members);
    expect(await detect(cfg())).toEqual([
      expect.objectContaining({ requirement: "membership-unreadable" }),
    ]);
  });
}

it("never includes corrupt record secrets in membership diagnostics", async ({ state }) => {
  state.applyEnv();
  await writeStoredClaw(claw({ alice: "viewer" }));
  await closeOpenClawStateDatabaseAsync();
  const secret = "abcdef0123456789".repeat(4);
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath());
  try {
    // Deliberately corrupt retained bytes; public writers only accept valid JSON.
    db.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    ).run(`{"invite":{"proof_key":${secret}"}}`, "core:openclaw-id", "@retained.claw", "invites");
  } finally {
    db.close();
  }
  const findings = await detect(cfg());
  expect(findings).toEqual([expect.objectContaining({ requirement: "membership-unreadable" })]);
  const diagnostic = JSON.stringify(findings);
  for (let i = 0; i <= secret.length - 8; i++) {
    expect(diagnostic).not.toContain(secret.slice(i, i + 8));
  }
  expect(findings[0]?.message).toBe(
    "Doctor could not read OpenClaw ID membership from the local claw record.",
  );
});

it("does not mistake an unreadable existing store for an unlinked install", async ({ state }) => {
  state.applyEnv();
  const databasePath = resolveOpenClawStateSqlitePath();
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.writeFile(databasePath, "not a SQLite database");
  const config = cfg();
  config.gateway!.roles!.default = "viewer";
  expect(await detect(config)).toEqual([
    expect.objectContaining({ requirement: "membership-unreadable" }),
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
