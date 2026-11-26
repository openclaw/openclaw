import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execNotify from "../agents/bash-tools.exec-notify.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { resolveGatewayToolOperatorSelection } from "../agents/tools/gateway-caller-context.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { readSessionEventTargetOperatorAuthority } from "../auto-reply/reply/session-event-target.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "../auto-reply/reply/session-event.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { assignSessionOwner, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { chatRef } from "../sessions/chat-ref.js";
import { owe } from "../sessions/owed.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { acknowledgeSessionEffectTransition } from "../sessions/session-controller.owner-context.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalOpenClawIdUserProfile,
  setCanonicalUserProfileRole,
  unlinkCanonicalOpenClawIdUserProfile,
} from "../state/user-profile-writes.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture as createPrFixture } from "./control-ui-session-pr-access.test-support.js";
import { createControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { setOpenClawIdMemberAccountLookup } from "./openclaw-id/tunnel-principal.js";
import {
  isNamedOperatorRoleEnforcementEnabled,
  isOperatorRoleEnforcedFor,
  operatorRoleSubject,
} from "./operator-role-enforcement.js";
import {
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";
// mock-isolation: Only model execution and the final child launch are synthetic.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const spawn = vi.hoisted(() => vi.fn());
vi.mock("../agents/subagents/spawn/subagent-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/subagents/spawn/subagent-spawn.js")>()),
  spawnSubagentDirect: spawn,
}));
await import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
  runtime.prewarmConfigDrivenReplyRuntime(),
);
const scope = { agentId: "main", sessionKey: "agent:main:resume-principal" };
const sessionId = "resume-principal-session";
const writerScopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.read", "operator.write"];
const config = {
  gateway: {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          scopes: writerScopes,
          agents: "*",
          sessions: { others: "none" },
        },
        reader: {
          scopes: ["operator.read"],
          agents: "*",
          sessions: { others: "none" },
        },
      },
    },
  },
} satisfies OpenClawConfig;

function principalContext(cfg: OpenClawConfig) {
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => cfg;
  context.getCommittedRuntimeConfig = () => cfg;
  return context;
}

async function admitPrincipal(params: Parameters<typeof prepareSessionPrincipalRunAuthority>[0]) {
  const admitted = await prepareSessionPrincipalRunAuthority(params);
  return { ...admitted, [Symbol.dispose]: admitted.release };
}

function fixture(cfg: OpenClawConfig = config) {
  setRuntimeConfigSnapshot(cfg);
  const profile = ensureProfileForEmail("resume-principal@example.test");
  const entry: SessionEntry = {
    sessionId,
    lifecycleRevision: "principal-incarnation",
    updatedAt: 1,
    visibility: "draft",
    createdActor: { type: "human", source: "profile", id: profile.id },
  };
  replaceSessionEntrySync(scope, entry);
  return {
    profile,
    entry,
    admit: (storePath = resolveOpenClawAgentSqlitePath({ agentId: scope.agentId })) =>
      admitPrincipal({
        ...scope,
        profileId: profile.id,
        sessionId,
        storePath,
        context: principalContext(cfg),
      }),
  };
}

it("admits a recorded person's current role and refuses revoked, demoted, archived and foreign targets", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, entry, admit } = fixture();
    const accepted = await admit();
    expect(accepted.authority.profileId).toBe(profile.id);
    expect(accepted.authority.scopes).toEqual(["operator.read", "operator.write"]);
    accepted.release();

    const logical = await admit(resolveSessionStorePathCore(undefined, { agentId: scope.agentId }));
    logical.release();
    await expect(
      admit(resolveOpenClawAgentSqlitePath({ agentId: "foreign-principal-store" })),
    ).rejects.toThrow("Session is unavailable");

    setUserProfileRole(profile.id, "reader");
    await expect(admit()).rejects.toThrow("no current run authority");
    setUserProfileRole(profile.id, "writer");

    replaceSessionEntrySync(scope, { ...entry, archivedAt: 1 });
    await expect(admit()).rejects.toThrow("Session is unavailable");
    const foreign = { ...scope, sessionKey: "agent:main:foreign-principal" };
    const other = ensureProfileForEmail("foreign-principal@example.test");
    replaceSessionEntrySync(foreign, {
      ...entry,
      sessionId: "foreign-session",
      createdActor: { type: "human", source: "profile", id: other.id },
    });
    await expect(
      prepareSessionPrincipalRunAuthority({
        ...foreign,
        profileId: profile.id,
        sessionId: "foreign-session",
        context: principalContext(config),
      }),
    ).rejects.toThrow();
    replaceSessionEntrySync(scope, entry);

    const replacement = ensureProfileForEmail("replacement-principal@example.test");
    linkEmail("resume-principal@example.test", replacement.id);
    await expect(admit()).rejects.toThrow();
  }));

it("retains admitted session access across row progress and later role edits", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, admit } = fixture();
    const accepted = await admit();
    const releaseRun = accepted.authority.retain?.();
    try {
      accepted.release();
      await patchSessionEntryCore(scope, () => ({ sessionId: "compacted-transcript" }), {
        skipMaintenance: true,
      });
      setUserProfileRole(profile.id, "reader");
      expect(accepted.authority.signal?.aborted).not.toBe(true);
    } finally {
      releaseRun?.();
      accepted.release();
    }
  }));

it.each([
  { change: "own sharing", patch: { visibility: "shared" as const }, allowed: true },
  {
    change: "run bookkeeping",
    patch: { lifecycleRunId: "resumed-run", activeWriterRunId: "resumed-run" },
    allowed: true,
  },
  { change: "archive", patch: { archivedAt: 1 }, allowed: false },
])("commits $change under the admitted principal and checks fresh starts", ({ patch, allowed }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { admit } = fixture();
    using accepted = await admit();
    expect(accepted.authority.profileId).toBeDefined();
    const committed = await patchSessionEntryCore(scope, () => patch, {
      skipMaintenance: true,
    });
    expect(committed).toMatchObject(patch);
    if (!allowed) {
      await expect(admit()).rejects.toThrow("Session is unavailable");
    }
  }),
);

it("admits the recorded Gateway owner without roles and never substitutes it for another person", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const owner = ensureGatewayOwnerProfile("Gateway owner");
    replaceSessionEntrySync(scope, {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    const params = {
      ...scope,
      sessionId,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: scope.agentId }),
      context: principalContext({}),
    };
    using accepted = await admitPrincipal({ ...params, profileId: owner.id });
    expect(accepted.authority.profileId).toBe(owner.id);
    expect(accepted.authority.scopes).toEqual(["operator.admin"]);
    expect(accepted.authority.recoverySnapshot).toBeUndefined();
    // Existing sessions may predate lifecycle revisions; reset still creates a new revision.
    const target = captureSessionTarget({
      storeScope: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
      physicalStorePath: params.storePath,
      ...scope,
      incarnation: sessionId,
    });
    const effect = await beginSessionEffect({ target });
    try {
      await effect.run(async () => {
        const compacted = await acceptCompactionSuccessor({
          currentTarget: params,
          expectedEntry: {
            sessionId,
            lifecycleRevision: undefined,
            activeWriterRunId: undefined,
          },
          assertActive: () => accepted.authority.signal?.throwIfAborted(),
          result: {
            ok: true,
            compacted: true,
            result: { sessionId: "legacy-compacted-transcript", tokensBefore: 0 },
          },
          onCommitted: ({ admissionTransition }) => {
            if (admissionTransition) {
              acknowledgeSessionEffectTransition(target, admissionTransition);
            }
          },
        });
        expect(compacted.entry.sessionId).toBe("legacy-compacted-transcript");
        // Ordinary initialization also acknowledges unchanged identity. Its nested
        // preparation must not take custody away from the retained outer turn.
        const preparation = await beginSessionEffect({ target });
        try {
          await preparation.run(() => {
            acknowledgeSessionEffectTransition(target, {
              previous: compacted.entry,
              current: compacted.entry,
            });
            return Promise.resolve();
          });
        } finally {
          preparation.release();
          await preparation.released;
        }
      });
    } finally {
      effect.release();
      await effect.released;
    }
    const other = ensureProfileForEmail("roleless@example.test");
    await expect(
      prepareSessionPrincipalRunAuthority({ ...params, profileId: other.id }),
    ).rejects.toThrow("Your role on this Gateway does not allow it");
  }));

it.for([
  { caller: "principal", scopes: ["operator.admin"], owner: true },
  { caller: "principal", scopes: ["operator.read", "operator.write"], owner: false },
  { caller: "principal", scopes: ["operator.sessions.write"], owner: false },
  { caller: "guest", scopes: ["operator.read", "operator.write"], owner: false },
] as const)(
  "exec completion retains $caller $scopes across later role edits",
  async ({ caller, scopes, owner }, { signal, onTestFinished }) => {
    await runEventFixture("event-principal", onTestFinished, async (state) => {
      const policy = structuredClone(config);
      policy.gateway.roles.definitions.writer.scopes = [...scopes];
      const cfg = await configureEventState(state, {
        ...policy,
        tools: { profile: "coding", codeMode: false, toolSearch: false },
      });
      const { profile: principal, admit } = fixture(cfg);
      assignSessionOwner(scope, {
        owner: {
          type: "human",
          id: caller === "guest" ? ensureGatewayOwnerProfile("Gateway owner").id : principal.id,
        },
        assignedBy: { type: "system", id: "exec-completion-fixture" },
      });
      const effects: string[] = [];
      spawn.mockReset().mockImplementation(async (_request, context) => {
        expect(resolveGatewayToolOperatorSelection().operatorAuthority).toMatchObject({
          profileId: principal.id,
          scopes,
        });
        if (effects.length) {
          setUserProfileRole(principal.id, "reader");
        }
        // A role edit does not revoke an already admitted completion turn.
        context.assertActive();
        effects.push("spawned");
        return { status: "accepted", runId: "event-child" };
      });
      vi.mocked(runEmbeddedAgent)
        .mockReset()
        .mockImplementation(async (params) => {
          expect(params.senderIsOwner).toBe(owner);
          expect(params.inputProvenance).toMatchObject({
            kind: "internal_system",
            sourceTool: "exec",
          });
          const { tools, close } = await openEventToolHost(params, "exec completion admission", {
            includeOpenClawTools: true,
          });
          try {
            const tool = tools.find((candidate) => candidate.name === "sessions_spawn")!;
            await expect(
              tool.execute("event-spawn", { task: "Continue requested work" }),
            ).resolves.toMatchObject({ details: { status: "accepted" } });
            await expect(
              tool.execute("later-spawn", { task: "Continue requested work" }),
            ).resolves.toMatchObject({ details: { status: "accepted" } });
          } finally {
            close();
          }
          return { payloads: [{ text: "Completion processed" }], meta: { durationMs: 1 } };
        });
      const context = principalContext(cfg);
      using origin = caller === "guest" ? await admit() : undefined;
      const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
        operatorAuthority: origin?.authority,
      });
      const receipt = withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          enqueueSessionEventForHost("Process completed; continue requested work.", {
            ...scope,
            source: "exec",
            expectedTarget: target,
            abortSignal: signal,
            deliver: false,
          }),
      );
      const outcome = await receipt.settled;
      expect(outcome, outcome.error).toMatchObject({
        status: "completed",
        executionStarted: true,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(effects).toEqual(["spawned", "spawned"]);
    });
  },
);

describe("canonical membership role admission", () => {
  const reader: GatewayOperatorRoleDefinition = {
    scopes: ["operator.read"],
    agents: ["main"],
    sessions: { others: "none" as const },
  };
  const memberConfig: OpenClawConfig = {
    gateway: { openclawId: { enabled: true }, roles: { definitions: { reader } } },
  };
  afterEach(() => setOpenClawIdMemberAccountLookup(undefined));

  it("keeps the global default switch separate from per-person catalog enforcement", () => {
    for (const member of [false, true]) {
      const subject = { profileId: "person", openclawIdMember: member };
      expect(isOperatorRoleEnforcedFor({}, subject)).toBe(false);
      expect(isNamedOperatorRoleEnforcementEnabled(memberConfig)).toBe(false);
      expect(isOperatorRoleEnforcedFor(memberConfig, subject)).toBe(member);
      expect(
        isOperatorRoleEnforcedFor({ gateway: { roles: { default: "reader" } } }, subject),
      ).toBe(true);
    }
  });

  it("joins prepared canonical links with current membership without socket or hot-path SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = await ensureCanonicalUserProfileForEmail("member@example.test");
      await setCanonicalUserProfileRole(profile.id, "reader");
      expect(
        await linkCanonicalOpenClawIdUserProfile({
          profileId: profile.id,
          accountId: "member",
          email: null,
        }),
      ).toMatchObject({ ok: true });
      const catalog = await prepareUserProfileCatalog();
      using _ = { [Symbol.dispose]: catalog.release };
      const prepared = await prepareUserProfileRoleAuthority(profile.id);
      expect(prepared?.openclawIdAccountIds).toEqual(["member"]);
      const members = new Set<string>();
      setOpenClawIdMemberAccountLookup((accountId) => members.has(accountId));
      const sql = observeMainThreadSql();
      try {
        expect(operatorRoleSubject(prepared)).toEqual({
          profileId: profile.id,
          openclawIdMember: false,
        });
        expect(resolveOperatorRolePolicyForProfile(profile.id, memberConfig)).toBeUndefined();
        members.add("member");
        expect(operatorRoleSubject(prepared)).toEqual({
          profileId: profile.id,
          openclawIdMember: true,
        });
        expect(resolveOperatorRolePolicyForProfile(profile.id, memberConfig)).toEqual(reader);
        expect(
          resolveOperatorRolePolicyForProfile(profile.id, {
            gateway: { openclawId: { enabled: true } },
          })?.scopes,
        ).toEqual([]);
        expect(
          resolveOperatorRolePolicyForAssignment(
            profile.id,
            null,
            memberConfig,
            null,
            operatorRoleSubject(prepared),
          )?.scopes,
        ).toEqual([]);
        members.delete("member");
        expect(resolveOperatorRolePolicyForProfile(profile.id, memberConfig)).toBeUndefined();
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      members.add("member");
      expect(await unlinkCanonicalOpenClawIdUserProfile({ profileId: profile.id })).toEqual({
        unlinked: true,
      });
      expect(prepared?.isCurrent()).toBe(false);
      const unlinked = await prepareUserProfileRoleAuthority(profile.id);
      expect(operatorRoleSubject(unlinked).openclawIdMember).toBe(false);
      expect(resolveOperatorRolePolicyForProfile(profile.id, memberConfig)).toBeUndefined();
    });
  });

  for (const initiallyMember of [true, false]) {
    it(`keeps recovery policy tied to its admitted member subject (${initiallyMember})`, async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
        const profile = await ensureCanonicalUserProfileForEmail("recovery-member@example.test");
        await setCanonicalUserProfileRole(profile.id, "reader");
        await linkCanonicalOpenClawIdUserProfile({
          profileId: profile.id,
          accountId: "recovery-member",
          email: null,
        });
        const catalog = await prepareUserProfileCatalog();
        using _ = { [Symbol.dispose]: catalog.release };
        let member = initiallyMember;
        setOpenClawIdMemberAccountLookup((accountId) => member && accountId === "recovery-member");
        // A recovered start needs write; the subject under test is the role policy, not its scopes.
        const role = {
          ...reader,
          scopes: ["operator.read", "operator.write"],
          sandbox: "required" as const,
        } satisfies GatewayOperatorRoleDefinition;
        const cfg: OpenClawConfig = {
          gateway: { openclawId: { enabled: true }, roles: { definitions: { reader: role } } },
        };
        setRuntimeConfigSnapshot(cfg);
        const recovery = await recoveryFixture(stateDir, profile.id, {
          config: cfg,
          scopes: ["operator.read", "operator.write"],
        });
        const recovered = await recovery.restore();
        try {
          if (initiallyMember) {
            expect(recovered.authority.rolePolicy).toMatchObject({
              sessionAccessCap: "none",
              sandboxRequired: true,
              agents: ["main"],
            });
            expect(recovered.authority.readCurrentRoleFacts?.().policy).toEqual(role);
            member = false;
            expect(recovered.authority.readCurrentRoleFacts?.().policy).toEqual(role);
          } else {
            expect(recovered.authority.rolePolicy).toBeUndefined();
            member = true;
            expect(recovered.authority.rolePolicy).toBeUndefined();
            const next = await recovery.restore();
            try {
              expect(next.authority.rolePolicy).toMatchObject({
                sessionAccessCap: "none",
                sandboxRequired: true,
                agents: ["main"],
              });
              expect(next.authority.readCurrentRoleFacts?.().policy).toEqual(role);
            } finally {
              next.release();
            }
          }
        } finally {
          recovered.release();
        }
      });
    });
  }

  it("rechecks a retained PR audience after membership-only admission", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const audience = await createPrFixture("operator.read");
      try {
        await linkCanonicalOpenClawIdUserProfile({
          profileId: audience.profile.id,
          accountId: "pr-reader",
          email: null,
        });
        const cfg = structuredClone(audience.cfg);
        cfg.gateway!.openclawId = { enabled: true };
        delete cfg.gateway!.roles!.default;
        cfg.gateway!.roles!.definitions.reader!.sessions.others = "none";
        setRuntimeConfigSnapshot(cfg);
        prepareGatewayRecipientProfile(audience.client);
        let member = false;
        setOpenClawIdMemberAccountLookup((accountId) => member && accountId === "pr-reader");
        const sessionKey = "agent:main:member-audience";
        await audience.seed(sessionKey, audience.other.id, { visibility: "shared" });
        await audience.subscribe([sessionKey]);
        const read = createControlUiSessionPrRead({
          client: audience.client,
          sessionKey,
          getRuntimeConfig: audience.context.getRuntimeConfig,
          getSessionRowProjection: () => getSessionRowProjection(audience.context),
          isCurrentClient: () => !audience.client.invalidated,
        });
        expect(read).toBeDefined();
        const target = await read?.();
        expect(target).toBeDefined();
        expect(await read?.()).toBe(target);
        member = true;
        expect(await read?.()).toBeUndefined();
      } finally {
        await audience.close();
      }
    });
  });
});

// Durable exec wake after a restart: the requester's recorded source, admitted again. A requester
// without session write (guest) is refused at start; the owed row then ends with a visible cause.
it.each([
  { requester: "admin", scopes: ["operator.admin"], owner: true },
  { requester: "writer", scopes: ["operator.read", "operator.write"], owner: false },
  { requester: "member", scopes: ["operator.sessions.write"], owner: false },
  { requester: "guest", scopes: ["operator.read"], owner: undefined },
])("wakes a durable exec result after a restart as its $requester requester", (cell) =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    setRuntimeConfigSnapshot({});
    const owner = ensureProfileForEmail("session-owner@example.test");
    const requester = ensureProfileForEmail("exec-requester@example.test");
    const exec = await recoveryFixture(stateDir, requester.id, {
      device: pairedOperator(),
      scopes: cell.scopes,
    });
    // Another person's session: the session principal is not the command's requester.
    await patchSessionEntryCore(
      exec.target,
      () => ({ createdActor: { type: "human", source: "profile", id: owner.id } }),
      { skipMaintenance: true },
    );
    await owe({
      id: "exec:durable-requester",
      to: chatRef(exec.target),
      kind: "exec",
      text: "Exec completed (durable, code 0)",
      originFacts: {
        operatorSource: captureQueuedOperatorRecoverySource(exec.sourceAuthority),
      },
    });
    using wake = vi.spyOn(execNotify, "wakeOwedExec").mockResolvedValue();
    await continueSessionQueuedInputs(exec.context, exec.target, {
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const target = wake.mock.calls[0]?.[1]?.expectedTarget;
    const authority = target && readSessionEventTargetOperatorAuthority(target);
    expect(authority && { profileId: authority.profileId, owner: authority.grant.owner }).toEqual(
      cell.owner === undefined ? undefined : { profileId: requester.id, owner: cell.owner },
    );
    expect(wake).toHaveBeenCalledTimes(cell.owner === undefined ? 0 : 1);
  }),
);
