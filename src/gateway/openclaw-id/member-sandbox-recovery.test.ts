import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assembleScheduledAdmissionFacts } from "../../cron/execution-context-admission.js";
import { makeIsolatedAgentJobFixture } from "../../cron/isolated-agent/job-fixtures.js";
import { linkOpenClawIdUserProfile } from "../../state/user-profile-openclaw-id.worker.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCreatorSandbox } from "../operator-role-policy.js";
import { recoveryFixture } from "../operator-run-recovery.test-support.js";
import { prepareGatewayOperatorSessionRun } from "../operator-session-run.js";
import { resolveAgentRunSessionCreation } from "../session-creation-provenance.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
} from "./tunnel-principal.js";

it("restored member runs and scheduled admission retain required profile sandbox facts without a default role", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (ctx) => {
    const profile = ensureProfileForEmail("member-recovery-sandbox@example.test");
    const principal = {
      kind: "member" as const,
      peerKey: `iroh:${"ab".repeat(32)}`,
      accountId: "guest",
      role: "display-only",
      authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
    };
    const config: OpenClawConfig = {
      gateway: {
        openclawId: { enabled: true },
        roles: {
          definitions: {
            guest: {
              sessions: { others: "view" as const },
              agents: "*" as const,
              scopes: ["operator.sessions.write", "operator.cron"],
              sandbox: "required" as const,
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    setUserProfileRole(profile.id, "guest");
    linkOpenClawIdUserProfile(
      { profileId: profile.id, accountId: principal.accountId, email: null },
      {},
    );
    setOpenClawIdMemberAccountLookup((accountId) => accountId === principal.accountId);
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    try {
      const fixture = await recoveryFixture(ctx.stateDir, profile.id, {
        config,
        scopes: ["operator.sessions.write", "operator.cron"],
        openclawIdPrincipal: principal,
      });
      expect(resolveCreatorSandbox(config, resolveAgentRunSessionCreation(fixture.client))).toBe(
        "required",
      );
      const restored = await fixture.restore();
      try {
        const run = prepareGatewayOperatorSessionRun({
          authority: restored.authority,
          cfg: config,
          agentId: "main",
          sessionKey: "agent:main:recovered-guest",
          currentSource: () => ({}),
        });
        expect(run.creation).toMatchObject({
          via: "run",
          sandbox: "required",
          actor: { type: "human", source: "profile", id: profile.id },
        });
        expect(() => run.assertAuthorized({ sessionId: "host", updatedAt: 1 })).toThrow(
          "sandboxed session",
        );
        expect(() =>
          run.assertAuthorized({ sessionId: "guest", updatedAt: 1, sandbox: "required" }),
        ).not.toThrow();
        const job = makeIsolatedAgentJobFixture({
          createdActor: { type: "human", source: "profile", id: profile.id },
          operatorSource: {
            executionRevision: "execution-1",
            source: {
              kind: "gateway",
              version: 1,
              agentId: "main",
              sourceRunId: "source-run",
              snapshot: fixture.snapshot,
            },
          },
        });
        expect(
          assembleScheduledAdmissionFacts(
            {
              cfg: config,
              job,
              trigger: "cron",
              runId: "occurrence",
              agentId: "main",
              runSessionKey: "agent:main:cron:guest",
            },
            undefined,
            false,
          ),
        ).toMatchObject({ creatorRoleSandbox: "required" });
      } finally {
        restored.release();
      }
    } finally {
      setOpenClawIdTunnelPrincipalLookup(undefined);
      setOpenClawIdMemberAccountLookup(undefined);
    }
  });
});
