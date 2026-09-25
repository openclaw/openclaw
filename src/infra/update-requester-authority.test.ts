import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandOwnerAuthority } from "../auto-reply/command-auth.js";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import { updateRepairParentMessageSchema } from "./update-repair-protocol.js";
import {
  createManagedUpdateRequesterAuthority,
  createManagedUpdateRequesterContinuationAuthority,
  prepareManagedUpdateRequesterIdentity,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";

vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: vi.fn(),
}));
vi.mock("./update-repair-agent.runtime.js", () => ({}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  });
});

describe("managed update requester authority", () => {
  let root: string;
  let configPath: string;
  let env: NodeJS.ProcessEnv;
  const requester = { channel: "synthetic", senderId: "owner" };
  const allowed = JSON.stringify({ commands: { ownerAllowFrom: ["owner"] } });

  beforeEach(async () => {
    root = tempDirs.make("update-requester-authority-");
    configPath = path.join(root, "openclaw.json");
    env = { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
    await fs.writeFile(configPath, allowed);
    vi.mocked(ensureCliPluginRegistryLoaded).mockReset().mockResolvedValue(undefined);
  });

  async function linkedAdmins() {
    const config: OpenClawConfig = {
      gateway: {
        auth: {
          identityScopes: {
            "ada@example.test": ["operator.admin"],
            "grace@example.test": ["operator.admin"],
          },
        },
        roles: {
          default: "member",
          definitions: {
            admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
            member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
          },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
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
    const authorizationSource = resolveCommandOwnerAuthority(
      config,
      channelRequester,
      options,
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

  it("preserves the admitted profile through ledger and worker handoffs and refuses effects after reassignment", async () => {
    const fixture = await linkedAdmins();
    const authority = await createManagedUpdateRequesterAuthority(fixture.requester, env);
    expect(authority.isCurrent()).toBe(true);
    const run = createUpdateRun(
      { trigger: "chat", origin: { requester: authority.requester } },
      { env },
    );
    const retained = getUpdateRun(run.runId, { env })?.origin.requester;
    expect(retained).toEqual(fixture.requester);
    const message = updateRepairParentMessageSchema.parse({
      type: "start",
      runId: run.runId,
      requester: retained,
      target: { installRoot: root, stateDir: root, configPath, workspaceDir: root },
      failure: { error: "Synthetic validation failure" },
      context: { phase: "validating" },
      budget: {},
    });
    expect(message.type).toBe("start");
    if (message.type !== "start" || !message.requester) {
      throw new Error("repair start lost its requester");
    }
    unlinkUserChannelIdentity(fixture.ada.id, fixture.identity, fixture.options);
    linkUserChannelIdentity(fixture.grace.id, fixture.identity, fixture.options);
    expect(
      resolveCommandOwnerAuthority(fixture.config, fixture.channelRequester, fixture.options)
        .source,
    ).toBe(`profile:${fixture.grace.id}`);
    const delegated = await createManagedUpdateRequesterAuthority(message.requester, env);
    expect(authority.isCurrent()).toBe(false);
    expect(delegated.isCurrent()).toBe(false);
    const validate = vi.fn();
    const result = await runUpdateRepairLoop({
      target: message.target,
      context: { error: "Synthetic validation failure", phase: "validating" },
      isCurrent: () => {
        if (!delegated.isCurrent()) {
          throw new UpdateRequesterRevokedError();
        }
        return true;
      },
      validate,
    });
    expect(result).toMatchObject({ status: "aborted", reason: "requester-revoked", attempts: [] });
    expect(validate).not.toHaveBeenCalled();
  });

  it("retains the original person-policy grant across updater checks and restoration", async () => {
    const fixture = await linkedAdmins();
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({ id: "required-update-access" });
    builder.registry.plugins.push(record);
    fixture.config.gateway!.roles!.definitions.admin!.accessPolicyPlugin = record.id;
    await fs.writeFile(configPath, JSON.stringify(fixture.config));
    let grant = new AbortController();
    const authorize = vi.fn(() => {
      const admittedGrant = grant;
      return {
        signal: admittedGrant.signal,
        assertCurrent: () => admittedGrant.signal.throwIfAborted(),
      };
    });
    builder
      .createApi(record, { config: fixture.config })
      .registerGatewayAccessPolicy({ authorize });
    setActivePluginRegistry(builder.registry);
    try {
      const authority = await createManagedUpdateRequesterAuthority(fixture.requester, env);
      expect(authority.isCurrent()).toBe(true);
      grant.abort();
      grant = new AbortController();
      expect(authority.isCurrent()).toBe(false);
      const validate = vi.fn();
      const result = await runUpdateRepairLoop({
        target: { installRoot: root, stateDir: root, configPath, workspaceDir: root },
        context: { error: "Synthetic validation failure", phase: "validating" },
        isCurrent: () => {
          if (!authority.isCurrent()) {
            throw new UpdateRequesterRevokedError();
          }
          return true;
        },
        validate,
      });
      expect(result).toMatchObject({
        status: "aborted",
        reason: "requester-revoked",
        attempts: [],
      });
      expect(validate).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledTimes(1);
      const next = await createManagedUpdateRequesterAuthority(fixture.requester, env);
      expect(next.isCurrent()).toBe(true);
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(authority.isCurrent()).toBe(false);
    } finally {
      await clearActivePluginRegistry(builder.registry);
    }
  });

  it.each([
    { source: "configured-owner", retainedRuns: 2 },
    { source: "profile", retainedRuns: 2 },
    { source: "configured-owner", retainedRuns: 500 },
  ])(
    "reads $retainedRuns retained runs under $source Doctor authority and rejects revocation",
    async ({ source, retainedRuns }) => {
      const fixture = await linkedAdmins();
      if (source === "configured-owner") {
        await fs.writeFile(configPath, allowed);
      }
      const identity = await prepareManagedUpdateRequesterIdentity(
        source === "profile" ? fixture.requester : requester,
        env,
      );
      for (let index = 2; index < retainedRuns; index++) {
        const historical = createUpdateRun({ trigger: "chat" }, { env });
        finishUpdateRun(historical.runId, { status: "failed", reason: "doctor-failed" }, { env });
      }
      const previous = createUpdateRun({ trigger: "chat" }, { env });
      finishUpdateRun(previous.runId, { status: "failed", reason: "doctor-failed" }, { env });
      const current = createUpdateRun(
        { trigger: "chat", origin: { requester: fixture.requester } },
        { env },
      );
      recordUpdateRunStep(
        current.runId,
        {
          step: "warning:openclaw doctor",
          status: "completed",
          detail: `Previous update ${previous.runId} rolled back; migrationWarnings: /Users/migrated/.openclaw/agents/main/sessions/sessions.json: entry_invalid, transcript_missing`,
        },
        { env },
      );
      const maintenance = createOpenClawDatabaseMaintenanceScope(undefined, () => {
        if (!identity.isCurrentIdentity()) {
          throw new UpdateRequesterRevokedError();
        }
      });
      try {
        expect(maintenance.run(() => getUpdateRun(current.runId, { env }))).toMatchObject({
          runId: current.runId,
          status: "running",
          steps: expect.arrayContaining([
            expect.objectContaining({ detail: expect.stringContaining(previous.runId) }),
          ]),
        });
        expect(getUpdateRun(previous.runId, { env })?.status).toBe("failed");
        unlinkUserChannelIdentity(fixture.ada.id, fixture.identity, fixture.options);
        await fs.writeFile(configPath, JSON.stringify({ commands: { ownerAllowFrom: ["other"] } }));
        expect(() => maintenance.run(() => getUpdateRun(current.runId, { env }))).toThrow(
          UpdateRequesterRevokedError,
        );
      } finally {
        await maintenance.close();
      }
    },
  );

  it("does not infer linked-profile authority for a source-less released driver", async () => {
    const fixture = await linkedAdmins();
    const legacy = await createManagedUpdateRequesterAuthority(fixture.channelRequester, env);
    expect(legacy.isCurrent()).toBe(false);
    await fs.writeFile(
      configPath,
      JSON.stringify({ commands: { ownerAllowFrom: [fixture.identity.senderId] } }),
    );
    expect(legacy.isCurrent()).toBe(true);
    const modern = await createManagedUpdateRequesterAuthority(fixture.requester, env);
    expect(modern.isCurrent()).toBe(false);
  });

  it.each(["callback", "local-executor"] as const)(
    "requires the original managed update owner, not a %s substitute",
    async (substitute) => {
      const fixture = await linkedAdmins();
      const run = createUpdateRun(
        { trigger: "chat", origin: { requester: fixture.requester } },
        { env },
      );
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

  it("rechecks linked profile state in the original installation while a worker uses copied state", async () => {
    const fixture = await linkedAdmins();
    const copied = tempDirs.make("update-requester-copy-");
    vi.stubEnv("OPENCLAW_STATE_DIR", copied);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(copied, "openclaw.json"));
    const authority = await createManagedUpdateRequesterAuthority(fixture.requester, env);
    expect(authority.isCurrent()).toBe(true);
    setUserProfileRole(fixture.ada.id, "member", fixture.options);
    expect(authority.isCurrent()).toBe(false);
  });

  it("preserves registry load failures instead of reporting revocation", async () => {
    const error = new Error("Synthetic plugin bundle unavailable");
    vi.mocked(ensureCliPluginRegistryLoaded).mockRejectedValueOnce(error);
    const authority = await createManagedUpdateRequesterAuthority(requester, env);
    expect(() => authority.isCurrent()).toThrow(error);
    const validate = vi.fn();
    const onEvent = vi.fn();
    const result = await runUpdateRepairLoop({
      target: { installRoot: root, stateDir: root, configPath, workspaceDir: root },
      context: { error: "Synthetic validation failure", phase: "validating" },
      isCurrent: authority.isCurrent,
      validate,
      onEvent,
    });
    expect(result).toMatchObject({ status: "aborted", reason: error.message, attempts: [] });
    expect(onEvent).toHaveBeenCalledWith({
      type: "stopped",
      status: "aborted",
      reason: error.message,
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("preserves config load failures during preparation", async () => {
    await fs.writeFile(configPath, "{");
    const authority = await createManagedUpdateRequesterAuthority(requester, env);
    expect(() => authority.isCurrent()).toThrow("JSON5");
  });

  it("distinguishes a failed policy recheck from revocation and reads recovered policy", async () => {
    const authority = await createManagedUpdateRequesterAuthority(requester, env);
    expect(authority.isCurrent()).toBe(true);
    await fs.writeFile(configPath, "{");
    expect(() => authority.isCurrent()).toThrow();
    await fs.writeFile(configPath, allowed);
    expect(authority.isCurrent()).toBe(true);
    await fs.writeFile(configPath, JSON.stringify({ commands: { ownerAllowFrom: ["other"] } }));
    expect(authority.isCurrent()).toBe(false);
  });
});
