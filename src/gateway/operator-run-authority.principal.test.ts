import { expect, it } from "vitest";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import {
  buildSessionEventContext,
  prepareSessionEventInput,
} from "../auto-reply/reply/session-event-context.js";
import type { SessionEventOptions } from "../auto-reply/reply/session-event-contract.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";

const scope = { agentId: "main", sessionKey: "agent:main:resume-principal" };
const sessionId = "resume-principal-session";
const config: OpenClawConfig = {
  gateway: {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          scopes: ["operator.read", "operator.write"],
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
};

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
      prepareSessionPrincipalRunAuthority({
        ...scope,
        profileId: profile.id,
        sessionId,
        storePath,
        context: { getRuntimeConfig: () => cfg },
      }),
  };
}

it("admits a recorded person's current role and refuses revoked, demoted, archived and foreign targets", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, entry, admit } = fixture();
    const accepted = await admit();
    expect(accepted.authority.profileId).toBe(profile.id);
    expect(accepted.authority.scopes).toEqual(["operator.read", "operator.write"]);
    expect(accepted.authority.assertCurrent).not.toThrow();
    accepted.release();
    expect(accepted.authority.assertCurrent).toThrow();

    const logical = await admit(resolveSessionStorePathCore(undefined, { agentId: scope.agentId }));
    expect(logical.authority.assertCurrent).not.toThrow();
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
        context: { getRuntimeConfig: () => config },
      }),
    ).rejects.toThrow();
    replaceSessionEntrySync(scope, entry);

    const replacement = ensureProfileForEmail("replacement-principal@example.test");
    linkEmail("resume-principal@example.test", replacement.id);
    await expect(admit()).rejects.toThrow();
  }));

it.each([
  { scopes: ["operator.admin"], owner: true },
  { scopes: ["operator.read", "operator.write"], owner: false },
  { scopes: ["operator.sessions.write"], owner: false },
] as const)(
  "keeps resumed principal scopes $scopes separate from owner authority",
  ({ scopes, owner }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: { scopes: [...scopes], agents: "*", sessions: { others: "none" } },
              reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
            },
          },
        },
      };
      const { profile, admit } = fixture(cfg);
      const accepted = await admit();
      try {
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
          env: state.env,
          operatorAuthority: accepted.authority,
        });
        const options: SessionEventOptions = {
          ...scope,
          source: "restart",
          expectedTarget: target,
        };
        const input = prepareSessionEventInput("Resume current work.", options);
        expect(input.operatorAuthority).toBe(accepted.authority);
        expect(input.operatorAuthority?.assertCurrent).not.toThrow();
        const ctx = buildSessionEventContext({
          ...input,
          text: "Resume current work.",
          options,
          occurrenceId: "principal-resume",
          target,
          assertCurrent: () => accepted.authority.assertCurrent(),
        });
        expect(ctx.CommandAuthorized).toBe(false);
        expect(
          resolveCommandAuthorization({ ctx, cfg, commandAuthorized: false }).senderIsOwner,
        ).toBe(owner);
        setUserProfileRole(profile.id, "reader");
        expect(input.operatorAuthority?.assertCurrent).toThrow();
      } finally {
        accepted.release();
      }
    }),
);

it("retains current session access through run custody and revokes it before later effects", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, entry, admit } = fixture();
    const accepted = await admit();
    const releaseRun = accepted.authority.retain?.();
    try {
      accepted.release();
      await patchSessionEntryCore(scope, () => ({ sessionId: "compacted-transcript" }), {
        skipMaintenance: true,
      });
      expect(accepted.authority.assertCurrent).not.toThrow();
      setUserProfileRole(profile.id, "reader");
      expect(accepted.authority.assertCurrent).toThrow();
      expect(accepted.authority.signal?.aborted).toBe(true);
    } finally {
      releaseRun?.();
      accepted.release();
    }

    setUserProfileRole(profile.id, "writer");
    replaceSessionEntrySync(scope, entry);
    for (const change of ["reset", "archive", "delete"] as const) {
      replaceSessionEntrySync(scope, entry);
      const next = await admit();
      try {
        if (change === "delete") {
          await deleteSessionEntryLifecycle({
            agentId: scope.agentId,
            storePath: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
            archiveTranscript: false,
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          });
        } else {
          replaceSessionEntrySync(scope, {
            ...entry,
            ...(change === "reset"
              ? { lifecycleRevision: "reset-incarnation" }
              : { archivedAt: 1 }),
          });
        }
        expect(next.authority.assertCurrent).toThrow();
      } finally {
        next.release();
      }
    }
  }));

it("admits a principal's same-store writer while its own sharing publication is pending", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { admit } = fixture();
    const accepted = await admit();
    let commitChecks = 0;
    const probe = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, check) => {
      if (request.stage === "commit") {
        commitChecks += 1;
      }
      check(request, grant);
    });
    try {
      await expect(
        patchSessionEntryCore(scope, () => ({ visibility: "shared" }), {
          skipMaintenance: true,
          workerGuard: { source: accepted.authority.assertCurrent },
        }),
      ).resolves.toMatchObject({ visibility: "shared" });
      expect(commitChecks).toBeGreaterThan(0);
      expect(accepted.authority.assertCurrent).not.toThrow();
      expect(accepted.authority.signal?.aborted).toBe(false);
    } finally {
      probe.mockRestore();
      accepted.release();
    }
  }));

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
      context: { getRuntimeConfig: () => ({}) },
    };
    const accepted = await prepareSessionPrincipalRunAuthority({ ...params, profileId: owner.id });
    try {
      expect(accepted.authority.profileId).toBe(owner.id);
      expect(accepted.authority.scopes).toEqual(["operator.admin"]);
      expect(accepted.authority.assertCurrent).not.toThrow();
      expect(accepted.authority.recoverySnapshot).toBeUndefined();
      // Existing sessions may predate lifecycle revisions; reset still creates a new revision.
      await patchSessionEntryCore(scope, () => ({ sessionId: "legacy-compacted-transcript" }), {
        skipMaintenance: true,
      });
      expect(accepted.authority.assertCurrent).not.toThrow();
    } finally {
      accepted.release();
    }
    const other = ensureProfileForEmail("roleless@example.test");
    await expect(
      prepareSessionPrincipalRunAuthority({ ...params, profileId: other.id }),
    ).rejects.toThrow("no current run authority");
  }));
