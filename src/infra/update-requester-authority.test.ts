import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureCommandOwnerIdentity } from "../auto-reply/command-owner-facts.js";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelOperatorAdminAuthority } from "../gateway/channel-operator-authority.js";
import { createAdminMemberRoleConfig } from "../gateway/operator-role.test-support.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../state/user-channel-identities.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { updateRepairParentMessageSchema } from "./update-repair-protocol.js";
import {
  createDelegatedUpdateRequesterAuthority,
  createManagedUpdateRequesterAuthority,
  createManagedUpdateRequesterContinuationAuthority,
  prepareUpdateRequesterIdentity,
  type UpdateRequester,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { getUpdateRunForProgressAsync } from "./update-run-reader.js";

vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: vi.fn(),
}));

// Doctor sources of installed plugins are unavailable while their state migration is pending.
const doctorSource = vi.hoisted(() => ({ unprepared: undefined as string | undefined }));
vi.mock("../commands/doctor/legacy-config-repair.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../commands/doctor/legacy-config-repair.js")>();
  const [
    { isPluginDoctorMigrationDeferred },
    { PluginSetupPreparationRequiredError },
    { createPluginManifestRecordFixture },
  ] = await Promise.all([
    import("../plugins/doctor-contract-registry.js"),
    import("../plugins/plugin-setup-module.js"),
    import("../plugins/plugin-metadata.test-support.js"),
  ]);
  return {
    ...actual,
    planLegacyConfigForUpdateChannel: (
      ...args: Parameters<typeof actual.planLegacyConfigForUpdateChannel>
    ) => {
      const id = doctorSource.unprepared;
      if (id && !isPluginDoctorMigrationDeferred(id)) {
        throw new PluginSetupPreparationRequiredError(
          createPluginManifestRecordFixture({ id, origin: "global" }),
          "/plugins/doctor.js",
          "/plugins",
        );
      }
      return actual.planLegacyConfigForUpdateChannel(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  });
});

let root: string;
let configPath: string;
let env: NodeJS.ProcessEnv;
const requester = { channel: "synthetic", senderId: "owner" };
const allowed = JSON.stringify({ commands: { ownerAllowFrom: ["owner"] } });
const target = () => ({ installRoot: root, stateDir: root, configPath, workspaceDir: root });
const writeConfig = (config: OpenClawConfig | string) =>
  fs.writeFile(configPath, typeof config === "string" ? config : JSON.stringify(config));
const authorityFor = (identity: UpdateRequester = requester) =>
  createManagedUpdateRequesterAuthority(identity, env);
const create = (identity?: UpdateRequester) =>
  createUpdateRun(
    { trigger: "chat", ...(identity ? { origin: { requester: identity } } : {}) },
    { env },
  );
function assertCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) {
    throw new UpdateRequesterRevokedError();
  }
  return true;
}
beforeEach(async () => {
  root = tempDirs.make("update-requester-authority-");
  configPath = path.join(root, "openclaw.json");
  env = { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
  await writeConfig(allowed);
  vi.mocked(ensureCliPluginRegistryLoaded).mockReset().mockResolvedValue(undefined);
  doctorSource.unprepared = undefined;
});

async function linkedAdmins() {
  const config: OpenClawConfig = createAdminMemberRoleConfig();
  await writeConfig(config);
  const options = { env };
  const ada = ensureProfileForEmail("ada@example.test", options);
  const grace = ensureProfileForEmail("grace@example.test", options);
  setUserProfileRole(ada.id, "admin", options);
  setUserProfileRole(grace.id, "admin", options);
  const identity = {
    channelId: "discord",
    accountId: "team-bot",
    senderId: "100000000000000001",
  };
  linkUserChannelIdentity(ada.id, identity, options);
  const channelRequester = {
    channel: identity.channelId,
    accountId: identity.accountId,
    senderId: identity.senderId,
  };
  const authorizationSource = captureCommandOwnerIdentity(
    config,
    channelRequester,
    options,
    resolveChannelOperatorAdminAuthority,
  ).source;
  expect(authorizationSource).toBe(`profile:${ada.id}`);
  return {
    config,
    options,
    ada,
    grace,
    identity,
    channelRequester,
    requester: { ...channelRequester, authorizationSource },
  };
}

it.each(["reassignment", "role change in original state"])(
  "retains profile handoffs but revokes effects after %s",
  async (change) => {
    const fixture = await linkedAdmins();
    if (change !== "reassignment") {
      const copied = tempDirs.make("update-requester-copy-");
      vi.stubEnv("OPENCLAW_STATE_DIR", copied);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(copied, "openclaw.json"));
    }
    const authority = await authorityFor(fixture.requester);
    expect(authority.isCurrent()).toBe(true);
    const run = create(authority.requester);
    const retained = getUpdateRun(run.runId, { env })?.origin.requester;
    expect(retained).toEqual(fixture.requester);
    const message = updateRepairParentMessageSchema.parse({
      type: "start",
      runId: run.runId,
      requester: retained,
      target: target(),
      failure: { error: "Synthetic validation failure" },
      context: { phase: "validating" },
      budget: {},
    });
    expect(message.type).toBe("start");
    if (message.type !== "start" || !message.requester) {
      throw new Error("repair start lost its requester");
    }
    if (change === "reassignment") {
      unlinkUserChannelIdentity(fixture.ada.id, fixture.identity, fixture.options);
      linkUserChannelIdentity(fixture.grace.id, fixture.identity, fixture.options);
      expect(
        captureCommandOwnerIdentity(
          fixture.config,
          fixture.channelRequester,
          fixture.options,
          resolveChannelOperatorAdminAuthority,
        ).source,
      ).toBe(`profile:${fixture.grace.id}`);
    } else {
      setUserProfileRole(fixture.ada.id, "member", fixture.options);
    }
    const delegated = await authorityFor(message.requester);
    expect([authority.isCurrent(), delegated.isCurrent()]).toEqual([false, false]);
  },
);

it("restored person policy cannot revive the original grant", async () => {
  const fixture = await linkedAdmins();
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: "required-update-access" });
  builder.registry.plugins.push(record);
  fixture.config.gateway!.roles!.definitions.admin!.accessPolicyPlugin = record.id;
  await writeConfig(fixture.config);
  let grant = new AbortController();
  const authorize = vi.fn(() => {
    const admittedGrant = grant;
    return {
      signal: admittedGrant.signal,
      assertCurrent: () => admittedGrant.signal.throwIfAborted(),
    };
  });
  builder.createApi(record, { config: fixture.config }).registerGatewayAccessPolicy({ authorize });
  setActivePluginRegistry(builder.registry);
  try {
    const authority = await authorityFor(fixture.requester);
    expect(authority.isCurrent()).toBe(true);
    grant.abort();
    grant = new AbortController();
    expect(authority.isCurrent()).toBe(false);
    expect(authorize).toHaveBeenCalledTimes(1);
    const next = await authorityFor(fixture.requester);
    expect(next.isCurrent()).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authority.isCurrent()).toBe(false);
  } finally {
    await clearActivePluginRegistry(builder.registry);
  }
});

it.each(["profile", "configured-owner"])(
  "%s Doctor reads run history until revoked",
  async (source) => {
    const fixture = await linkedAdmins();
    if (source === "configured-owner") {
      await writeConfig(allowed);
    }
    const identity = await prepareUpdateRequesterIdentity(
      source === "profile" ? fixture.requester : requester,
      env,
    );
    const current = create(fixture.requester);
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: () => assertCurrent(identity.isCurrentIdentity),
    });
    try {
      expect(maintenance.run(() => getUpdateRun(current.runId, { env }))).toMatchObject({
        runId: current.runId,
        status: "running",
      });
      unlinkUserChannelIdentity(fixture.ada.id, fixture.identity, fixture.options);
      await writeConfig({ commands: { ownerAllowFrom: ["other"] } });
      expect(() => maintenance.run(() => getUpdateRun(current.runId, { env }))).toThrow(
        UpdateRequesterRevokedError,
      );
    } finally {
      await maintenance.close();
    }
  },
);

it("legacy drivers cannot acquire linked-profile authority", async () => {
  const fixture = await linkedAdmins();
  const legacy = await authorityFor(fixture.channelRequester);
  expect(legacy.isCurrent()).toBe(false);
  await writeConfig({ commands: { ownerAllowFrom: [fixture.identity.senderId] } });
  expect(legacy.isCurrent()).toBe(true);
  const modern = await authorityFor(fixture.requester);
  expect(modern.isCurrent()).toBe(false);
});

it.each(["callback", "local-executor"] as const)(
  "rejects a substitute %s update owner",
  async (substitute) => {
    const fixture = await linkedAdmins();
    const run = create(fixture.requester);
    const reject = (executor: { assertCurrent: () => void }) =>
      expect(
        createManagedUpdateRequesterContinuationAuthority(
          fixture.requester,
          { runId: run.runId, executor },
          env,
        ),
      ).rejects.toThrow("admitted Gateway update owner");
    if (substitute === "callback") {
      await reject({ assertCurrent() {} });
      return;
    }
    const temp = await import("./tmp-openclaw-dir.js");
    const selected = vi.spyOn(temp, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    try {
      await withUpdateCommandExecutor(run.runId, async (owner) => {
        const fence = await owner.enter(root);
        await reject(fence);
        fence.assertCurrent();
      });
    } finally {
      selected.mockRestore();
    }
  },
);

it.each([true, false])(
  "keeps a prefixed configured owner current when plugins await Doctor migrations: %s",
  async (pendingOnly) => {
    await writeConfig({ commands: { ownerAllowFrom: ["telegram:owner"] } });
    const registry = createTestPluginRegistry().registry;
    registry.plugins.push(createPluginRecord({ id: "telegram", status: "error" }));
    registry.diagnostics.push({
      level: "error",
      pluginId: "telegram",
      message: "pending",
      ...(pendingOnly ? { code: "plugin-state-migration" as const } : {}),
    });
    const { PluginLoadFailureError } = await import("../plugins/loader-shared.js");
    const error = new PluginLoadFailureError(registry, registry.plugins);
    vi.mocked(ensureCliPluginRegistryLoaded).mockRejectedValueOnce(error);
    const authority = await authorityFor({ channel: "telegram", senderId: "owner" });
    if (!pendingOnly) {
      expect(() => authority.isCurrent()).toThrow(error);
      return;
    }
    expect(authority.isCurrent()).toBe(true);
    await writeConfig({ commands: { ownerAllowFrom: ["telegram:other"] } });
    expect(authority.isCurrent()).toBe(false);
  },
);

it.each(["discord", "mattermost"])(
  "keeps a typed %s owner current only while the owner entry remains configured",
  async (channel) => {
    const registry = createTestPluginRegistry().registry;
    registry.plugins.push(
      createPluginRecord({ id: channel, status: "error", channelIds: [channel] }),
    );
    registry.diagnostics.push({
      level: "error",
      pluginId: channel,
      message: "pending",
      code: "plugin-state-migration",
    });
    const { PluginLoadFailureError } = await import("../plugins/loader-shared.js");
    vi.mocked(ensureCliPluginRegistryLoaded).mockRejectedValueOnce(
      new PluginLoadFailureError(registry, registry.plugins),
    );
    setActivePluginRegistry(registry);
    try {
      await writeConfig({ commands: { ownerAllowFrom: [`${channel}:user:100000000000000001`] } });
      const authority = await authorityFor({ channel, senderId: "100000000000000001" });
      expect(authority.isCurrent()).toBe(true);
      await writeConfig({ commands: { ownerAllowFrom: [`${channel}:user:100000000000000002`] } });
      expect(authority.isCurrent()).toBe(false);
    } finally {
      await clearActivePluginRegistry(registry);
    }
  },
);

it.each([undefined, "discord"])(
  "checks an owner against the Doctor migration without publishing it (unprepared: %s)",
  async (unprepared) => {
    doctorSource.unprepared = unprepared;
    const legacy = (owner: string) =>
      JSON.stringify({
        commands: { ownerAllowFrom: [`telegram:${owner}`] },
        skills: { workshop: { autonomous: { mode: "auto", channelNotices: true } } },
      });
    const original = legacy("1001");
    await writeConfig(original);
    const authority = await createDelegatedUpdateRequesterAuthority(
      { channel: "telegram", senderId: "1001", authorizationSource: "configured-owner" },
      "run",
      { assertCurrent() {} },
      env,
    );
    expect(authority.isCurrent()).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    await writeConfig(legacy("1002"));
    expect(authority.isCurrent()).toBe(false);
  },
);

it.each(["registry", "config preparation", "config recheck"])(
  "reports %s failure, not revocation",
  async (failure) => {
    const error = new Error("Synthetic plugin bundle unavailable");
    if (failure === "registry") {
      vi.mocked(ensureCliPluginRegistryLoaded).mockRejectedValueOnce(error);
    } else if (failure === "config preparation") {
      await writeConfig("{");
    }
    const authority = await authorityFor();
    if (failure === "config recheck") {
      expect(authority.isCurrent()).toBe(true);
      await writeConfig("{");
    }
    expect(() => authority.isCurrent()).toThrow(failure === "registry" ? error : "JSON5");
    if (failure === "config recheck") {
      await writeConfig(allowed);
      expect(authority.isCurrent()).toBe(true);
      await writeConfig({ commands: { ownerAllowFrom: ["other"] } });
      expect(authority.isCurrent()).toBe(false);
    }
  },
);

it.each(["owner check", "identity preparation"] as const)(
  "the update helper's %s releases worker-held state readers before Doctor",
  async (entry) => {
    // The managed handoff helper outlives this check while Doctor and rollback take
    // native exclusion; an idle retained WAL reader would hold their shared lock.
    const run = create();
    // Only the requester check may hold a connection when exclusion is attempted.
    await closeOpenClawStateDatabaseAsync();
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    vi.mocked(ensureCliPluginRegistryLoaded).mockImplementationOnce(async () => {
      await getUpdateRunForProgressAsync(run.runId, { env });
    });
    const helper = await import("../cli/daemon-cli.js");
    if (entry === "owner check") {
      expect(await helper.isManagedUpdateRequesterOwner(requester)).toBe(true);
    } else {
      expect((await helper.prepareManagedUpdateRequesterIdentity(requester)).requester).toEqual(
        requester,
      );
    }
    const exclusive = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    try {
      exclusive.exec(
        "PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;",
      );
    } finally {
      exclusive.close();
    }
  },
);
