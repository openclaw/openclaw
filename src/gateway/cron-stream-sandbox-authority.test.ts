import { afterEach, expect, it, vi } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SandboxBackendHandle } from "../agents/sandbox/backend-handle.types.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { bindSandboxPersistentExecCapability } from "../agents/sandbox/persistent-exec.types.js";
import { bindStreamSandboxContext } from "../agents/sandbox/stream-context.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import {
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { makeCronStreamSandboxTarget } from "../cron/stream-sandbox.test-support.js";
import type { CronStoredJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { commitBackgroundResultToSession } from "../sessions/background-session-result.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCronStreamSandboxAuthority } from "./cron-stream-sandbox-authority.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

const mocks = vi.hoisted(() => ({
  afterSessionEntryResult: undefined as (() => void) | undefined,
  sandbox:
    vi.fn<
      typeof import("../agents/sandbox/context.js").resolveSandboxContextForPersistentExecution
    >(),
}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        get fileIdentity() {
          return owned.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace") {
                    mocks.afterSessionEntryResult?.();
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});
// mock-isolation: The fixture supplies sandbox identity without provisioning a real container.
vi.mock("../agents/sandbox/context.js", () => ({
  resolveSandboxContextForPersistentExecution: mocks.sandbox,
}));
// mock-isolation: Authority tests retain fixture skill revisions without loading installed skills.
vi.mock("../skills/runtime/cron-snapshot.js", () => ({
  resolveCronSkillsSnapshot: async (params: { librarySelections?: unknown }) => ({
    prompt: "",
    skills: [],
    librarySelections: params.librarySelections,
  }),
}));

afterEach(() => {
  mocks.afterSessionEntryResult = undefined;
  mocks.sandbox.mockReset();
});

function sandboxFixture(
  job: CronStoredJob,
  config: OpenClawConfig,
  authority?: AdmittedRunOperatorAuthority,
): SandboxContext {
  const target = job.streamSandbox;
  if (!target) {
    throw new Error("missing fixture sandbox target");
  }
  const backend: SandboxBackendHandle = {
    id: "docker",
    runtimeId: "sandbox",
    runtimeLabel: "sandbox",
    workdir: target.containerWorkdir,
    buildExecSpec: async () => {
      throw new Error("unexpected shell execution");
    },
    runShellCommand: async () => {
      throw new Error("unexpected shell execution");
    },
  };
  bindSandboxPersistentExecCapability(backend, {
    target: { kind: "docker", endpoint: "unix:///fixture/docker.sock", daemonId: "fixture" },
    containerId: "a".repeat(64),
    containerName: "sandbox",
    containerStartedAt: "2026-01-01T00:00:00.000Z",
    workdir: target.containerWorkdir,
    configHash: target.configLabel,
    imageReference: resolveSandboxConfigForAgent(config, target.agentId).docker.image,
    resolveImage: async () => `sha256:${"b".repeat(64)}`,
    prepare: async () => {
      throw new Error("unexpected persistent execution");
    },
  });
  const sandbox: SandboxContext = {
    [Symbol.dispose]: vi.fn(),
    enabled: true,
    backendId: "docker",
    backend,
    sessionKey: target.sessionKey,
    workspaceDir: target.workspaceDir,
    agentWorkspaceDir: target.agentWorkspaceDir,
    workspaceAccess: target.workspaceAccess,
    runtimeId: "sandbox",
    runtimeLabel: "sandbox",
    containerName: "sandbox",
    containerWorkdir: target.containerWorkdir,
    docker: resolveSandboxConfigForAgent(config, target.agentId).docker,
    tools: {},
    browserAllowHostControl: false,
  };
  bindStreamSandboxContext(sandbox, {
    agentId: target.agentId,
    scopeKey: target.scopeKey,
    operatorAuthority: authority,
  });
  return sandbox;
}

async function withAuthorityFixture(
  run: (fixture: {
    job: CronStoredJob;
    config: OpenClawConfig;
    session: SessionEntry;
    profileId: string;
    grant: AbortController;
    resume: ReturnType<typeof vi.fn>;
    authorize: ReturnType<typeof vi.fn>;
    prepare: () => ReturnType<typeof prepareCronStreamSandboxAuthority>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const profile = ensureProfileForEmail("sandbox-stream@example.test");
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "openai/fixture-model" },
          sandbox: { mode: "all", backend: "docker" },
        },
      },
    };
    const session: SessionEntry = {
      sessionId: "creator-session",
      lifecycleRevision: "creator-generation",
      updatedAt: 1,
      createdActor: { type: "human", id: profile.id, source: "profile" },
    };
    const target = makeCronStreamSandboxTarget({
      agentWorkspaceDir: state.workspaceDir,
      operator: {
        profileId: profile.id,
        scopes: ["operator.write"],
        assignedRole: null,
        githubLogin: null,
        gatewayAccessGrant: { pluginId: "stream-access", grantId: "original-grant" },
      },
    });
    const job: CronStoredJob = {
      ...makeCronJob({ schedule: { kind: "stream", command: ["watch-source"] } }),
      streamSandbox: target,
    };
    replaceSessionEntrySync({ agentId: target.agentId, sessionKey: target.sessionKey }, session);
    const grant = new AbortController();
    const access = {
      grantId: "original-grant",
      signal: grant.signal,
      assertCurrent: () => grant.signal.throwIfAborted(),
    };
    const resume = vi.fn(() => access);
    const authorize = vi.fn(() => undefined);
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "stream-access" }));
    registry.gatewayAccessPolicies.push({
      pluginId: "stream-access",
      source: "/fixture/stream-access",
      policy: { authorize, resume },
    });
    const previousRegistry =
      getPluginRegistryState()?.activeRegistry ?? createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    mocks.sandbox.mockImplementation(async (_params, authority) =>
      sandboxFixture(job, config, authority),
    );
    try {
      await run({
        job,
        config,
        session,
        profileId: profile.id,
        grant,
        resume,
        authorize,
        prepare: () =>
          prepareCronStreamSandboxAuthority({
            job,
            getRuntimeConfig: () => config,
            assertCurrent: () => {},
          }),
      });
    } finally {
      setActivePluginRegistry(previousRegistry);
    }
  });
}

it.each([
  "grant",
  "role",
  "email binding",
  "skills",
  "sandbox mode",
  "sandbox default allow provenance",
  "permission mode",
  "exec host",
] as const)("revokes retained sandbox execution after its original %s changes", async (change) => {
  await withAuthorityFixture(async (fixture) => {
    const retained = await fixture.prepare();
    try {
      retained.assertCurrent();
      expect(mocks.sandbox.mock.lastCall?.[1]?.gatewayAccessGrant).toEqual(
        fixture.job.streamSandbox?.operator?.gatewayAccessGrant,
      );
      if (change === "grant") {
        const replacement = new AbortController();
        fixture.resume.mockReturnValue({
          grantId: "original-grant",
          signal: replacement.signal,
          assertCurrent: () => {},
        });
        fixture.grant.abort(new Error("original grant revoked"));
      } else if (change === "role") {
        await setCanonicalUserProfileRole(fixture.profileId, "changed");
        invalidateOperatorRolePolicy(fixture.profileId);
      } else if (change === "email binding") {
        const other = ensureProfileForEmail("other-stream@example.test");
        await linkCanonicalUserProfileEmail("sandbox-stream@example.test", other.id);
        await linkCanonicalUserProfileEmail("sandbox-stream@example.test", fixture.profileId);
      } else if (change === "sandbox default allow provenance") {
        const { allow, deny } = resolveSandboxConfigForAgent(fixture.config, "main").tools;
        fixture.config.tools = {
          sandbox: { tools: { allow: [...(allow ?? [])], deny: [...(deny ?? [])] } },
        };
        expect(retained.assertCurrent).toThrow();
      } else {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:watcher" },
          {
            ...fixture.session,
            ...(change === "skills"
              ? {
                  skillLibrarySelections: [
                    {
                      skillId: "changed-skill",
                      revision: "a".repeat(64),
                      name: "changed",
                      ownerProfileId: fixture.profileId,
                    },
                  ],
                }
              : change === "permission mode"
                ? { permissionMode: "read-only" }
                : change === "exec host"
                  ? { execHost: "gateway" }
                  : { sandboxMode: "off" }),
          },
        );
      }
      expect(retained.signal.aborted).toBe(true);
      expect(retained.assertCurrent).toThrow();
    } finally {
      retained.release();
    }
    retained.release();
    expect(retained.sandbox[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(retained.assertCurrent).toThrow();
  });
});

it.each([
  "explicit deny",
  "node placement",
  "tool allowlist",
  "tool profile",
  "provider policy",
] as const)(
  "enforces current %s before renewal and before another sandbox is prepared",
  async (restriction) => {
    await withAuthorityFixture(async (fixture) => {
      const retained = await fixture.prepare();
      try {
        retained.assertCurrent();
        fixture.config.tools =
          restriction === "explicit deny"
            ? { exec: { mode: "deny" } }
            : restriction === "node placement"
              ? { exec: { host: "node" } }
              : restriction === "tool allowlist"
                ? { allow: ["read"] }
                : restriction === "tool profile"
                  ? { profile: "minimal" }
                  : { byProvider: { openai: { deny: ["exec"] } } };
        expect(retained.assertCurrent).toThrow();
        expect(retained.signal.aborted).toBe(true);
        await expect(fixture.prepare()).rejects.toThrow();
        expect(mocks.sandbox).toHaveBeenCalledOnce();
      } finally {
        retained.release();
      }
    });
  },
);

it.each(["reset", "compaction"] as const)(
  "checks the active session %s fence before retained execution and fresh preparation",
  async (mutationKind) => {
    await withAuthorityFixture(async (fixture) => {
      const target = fixture.job.streamSandbox;
      if (!target) {
        throw new Error("missing fixture sandbox target");
      }
      const session = await prepareSessionMutationFacts({
        cfg: fixture.config,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      });
      const retained = await fixture.prepare();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const mutation = runSessionMutation({
        scope: session.storageTarget.storePath,
        identities: [target.sessionKey, target.sessionId],
        kind: mutationKind,
        policy: "allow-live",

        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      try {
        await entered.promise;
        expect(session.readCurrent(fixture.config).target.entry).toMatchObject({
          sessionId: target.sessionId,
          lifecycleRevision: target.lifecycleRevision,
        });
        if (mutationKind === "reset") {
          expect(retained.assertCurrent).toThrow("authority changed");
          expect(retained.signal.aborted).toBe(true);
          await expect(fixture.prepare()).rejects.toThrow("authority changed");
          expect(mocks.sandbox).toHaveBeenCalledOnce();
        } else {
          retained.assertCurrent();
          expect(retained.signal.aborted).toBe(false);
          const fresh = await fixture.prepare();
          try {
            fresh.assertCurrent();
            expect(fresh.signal.aborted).toBe(false);
          } finally {
            fresh.release();
          }
        }
      } finally {
        release.resolve();
        await mutation;
        retained.release();
        session.release();
      }
    });
  },
);

it("keeps sandbox source authority through a real background notification commit", async () => {
  await withAuthorityFixture(async (fixture) => {
    const target = fixture.job.streamSandbox;
    if (!target) {
      throw new Error("missing sandbox target");
    }
    const retained = await fixture.prepare();
    try {
      const result = await commitBackgroundResultToSession({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        expectedGeneration: {
          sessionId: target.sessionId,
          lifecycleRevision: target.lifecycleRevision,
        },
        text: "Watcher found a new error.",
        idempotencyKey: "watcher-result:1",
        provenance: { kind: "cron", jobId: fixture.job.id, runId: "watcher-run:1" },
        config: fixture.config,
      });
      expect(result).toMatchObject({ ok: true });
      expect(
        await loadTranscriptEvents({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              content: [{ type: "text", text: "Watcher found a new error." }],
            }),
          }),
        ]),
      );
      expect(retained.signal.aborted).toBe(false);
      retained.assertCurrent();
    } finally {
      retained.release();
    }
  });
});

it("preserves sandbox streams across native read markers and concurrent run projections but revokes mixed permission changes", async () => {
  await withAuthorityFixture(async (fixture) => {
    const target = fixture.job.streamSandbox;
    if (!target) {
      throw new Error("missing fixture sandbox target");
    }
    const { sessionMutationHandlers } = await import("./server-methods/sessions-mutations.js");
    const { createSessionMutationTestClient, createSessionMutationTestContext } =
      await import("./server-methods/sessions-mutations.owner.test-support.js");
    const { registerAgentRunContext, clearAgentRunContext } =
      await import("../infra/agent-run-registry.js");
    const retained = await fixture.prepare();
    const client = createSessionMutationTestClient(fixture.profileId);
    const context = createSessionMutationTestContext(fixture.config);
    try {
      for (const unread of [false, true]) {
        const respond = vi.fn();
        const params = {
          key: target.sessionKey,
          unread,
          ...(unread ? {} : { expectedMarkedUnreadAt: null }),
        };
        let registrationObserved = false;
        // Native admission and COMMIT are real; register the next turn before reply settlement.
        mocks.afterSessionEntryResult = () => {
          mocks.afterSessionEntryResult = undefined;
          expect(retained.signal.aborted).toBe(false);
          registerAgentRunContext("read-marker-next-turn", {
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
          });
          registrationObserved = true;
        };
        await sessionMutationHandlers["sessions.patch"]!({
          req: { type: "req", id: `read-marker-${unread}`, method: "sessions.patch", params },
          params,
          isWebchatConnect: () => true,
          client,
          context,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            entry: expect.objectContaining({
              sessionId: target.sessionId,
              lifecycleRevision: target.lifecycleRevision,
              ...(unread
                ? { markedUnreadAt: expect.any(Number) }
                : { lastReadAt: expect.any(Number) }),
            }),
          }),
          undefined,
        );
        expect(retained.signal.aborted).toBe(false);
        expect(registrationObserved).toBe(true);
        retained.assertCurrent();
        clearAgentRunContext("read-marker-next-turn");
      }
      const respond = vi.fn();
      const params = { key: target.sessionKey, unread: false, permissionMode: "read-only" };
      await sessionMutationHandlers["sessions.patch"]!({
        req: { type: "req", id: "mixed-permission-change", method: "sessions.patch", params },
        params,
        isWebchatConnect: () => true,
        client,
        context,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          entry: expect.objectContaining({ permissionMode: "read-only" }),
        }),
        undefined,
      );
      expect(retained.signal.aborted).toBe(true);
      expect(retained.assertCurrent).toThrow();
    } finally {
      mocks.afterSessionEntryResult = undefined;
      retained.release();
      clearAgentRunContext("read-marker-next-turn");
    }
  });
});

it("retains saved sandbox consent with guarded execution and an independently restricted event payload", async () => {
  await withAuthorityFixture(async (fixture) => {
    fixture.config.tools = { exec: { ask: "always" } };
    fixture.job.payload.toolsAllow = ["read"];
    fixture.job.scheduledToolPolicy = { version: 1, mode: "trusted" };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:watcher" },
      {
        ...fixture.session,
        permissionMode: "guarded",
      },
    );
    const retained = await fixture.prepare();
    try {
      retained.assertCurrent();
      expect(retained.signal.aborted).toBe(false);
    } finally {
      retained.release();
    }
    const restarted = await fixture.prepare();
    try {
      restarted.assertCurrent();
      expect(mocks.sandbox).toHaveBeenCalledTimes(2);
    } finally {
      restarted.release();
    }
  });
});

it("preserves explicit independent access and rejects an unclassified grant", async () => {
  await withAuthorityFixture(async (fixture) => {
    const operator = fixture.job.streamSandbox?.operator;
    if (!operator) {
      throw new Error("missing fixture operator");
    }
    operator.gatewayAccessGrant = null;
    const retained = await fixture.prepare();
    try {
      expect(fixture.resume).not.toHaveBeenCalled();
      expect(mocks.sandbox.mock.lastCall?.[1]?.gatewayAccessGrant).toBeNull();
      retained.assertCurrent();
    } finally {
      retained.release();
    }
    Reflect.deleteProperty(operator, "gatewayAccessGrant");
    await expect(fixture.prepare()).rejects.toThrow("target is unavailable");
    expect(mocks.sandbox).toHaveBeenCalledOnce();
  });
});

it.each(["grant revocation", "target replacement"] as const)(
  "rejects %s during awaited sandbox provisioning before publishing a runtime",
  async (change) => {
    await withAuthorityFixture(async (fixture) => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let authority: AdmittedRunOperatorAuthority | undefined;
      let sandbox: SandboxContext | undefined;
      mocks.sandbox.mockImplementation(async (_params, captured) => {
        authority = captured;
        entered.resolve();
        await resume.promise;
        const target = fixture.job.streamSandbox;
        sandbox = sandboxFixture(
          change === "target replacement" && target
            ? { ...fixture.job, streamSandbox: { ...target, configLabel: "different-config" } }
            : fixture.job,
          fixture.config,
          captured,
        );
        return sandbox;
      });
      const pending = fixture.prepare();
      const rejection = expect(pending).rejects.toThrow(
        change === "grant revocation" ? "original grant revoked" : "authority changed",
      );
      await entered.promise;
      if (change === "grant revocation") {
        fixture.grant.abort(new Error("original grant revoked"));
      }
      resume.resolve();
      await rejection;
      expect(sandbox?.[Symbol.dispose]).toHaveBeenCalledOnce();
      expect(authority?.signal?.aborted).toBe(true);
      expect(authority?.assertCurrent).toThrow();
    });
  },
);
