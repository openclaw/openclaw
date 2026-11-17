import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { prepareSessionEventInput } from "../auto-reply/reply/session-event-context.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./openclaw-id/tunnel-principal.js";
import { recoveryFixture } from "./operator-run-recovery.test-support.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

// The harness supplies a fixed tool-policy fingerprint; requester and channel authorization,
// durable shutdown markers, restoration, and event-target admission are production owners.
it.each([
  "shared-main",
  "different-owner",
  "revoked",
  "read-only",
  "own-session",
  "foreign-session",
] as const)(
  "preserves the interrupted channel requester rather than the session principal (%s)",
  (mode) =>
    withAdminIngress(async ({ admins, context, cfg, gateway }) => {
      const person = expectDefined(admins[0], "original requester");
      const other = expectDefined(admins[1], "other administrator");
      const turn = await context(person.identity.senderId);
      const original = createAdmittedRunOperatorAuthority({
        ...expectDefined(
          prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
          "authenticated channel requester",
        ),
        scopes:
          mode === "read-only"
            ? ["operator.read"]
            : mode === "own-session" || mode === "foreign-session"
              ? ["operator.sessions.write"]
              : ["operator.read", "operator.write"],
      });
      const target = { agentId: "main", sessionKey: "agent:main:main", sessionId: "shared-main" };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: Date.now(),
        ...(mode === "shared-main"
          ? {}
          : {
              createdActor: {
                type: "human" as const,
                source: "profile" as const,
                id: mode === "own-session" ? person.profile.id : other.profile.id,
              },
            }),
      });
      // Another accepted participant must not replace the interrupted turn owner.
      const otherTurn = await context(other.identity.senderId);
      const otherAuthority = expectDefined(
        prepareInternalGetReplyOptions(undefined, otherTurn)?.operatorAuthority,
        "other participant",
      );
      await withSessionTurn(target, async (operation) => {
        const active = expectDefined(operation, "active shared-main operation");
        await active.bindToolAuthoritySnapshotAsync({
          personalToolOwner: { operatorAuthority: original },
          fingerprint: () => "restart-policy",
          fingerprintAsync: async () => "restart-policy",
          project: () => "restart-policy",
          projectAsync: async () => "restart-policy",
        });
        active.personalToolParticipants?.accept({ operatorAuthority: otherAuthority });
        await persistRunningSessionsForRestart({ cfg });
      });
      expect((await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart).toBeDefined();
      if (mode === "revoked") {
        setUserProfileRole(person.profile.id, "reader");
      }
      const resumed: Array<{ profileId?: string; scopes?: readonly string[] }> = [];
      const enqueue = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation((text, options) => {
          const input = prepareSessionEventInput(text, options);
          input.operatorAuthority?.assertCurrent();
          resumed.push({
            profileId: input.operatorAuthority?.profileId,
            scopes: input.operatorAuthority?.scopes,
          });
          return {
            id: "restored-input",
            accepted: Promise.resolve({ ok: true }),
            settled: Promise.resolve({
              status: "completed",
              executionStarted: true,
              delivered: false,
            }),
            cancel: () => false,
          };
        });
      const warn = vi.fn();
      try {
        gateway.resolveGatewayContext = () => gateway;
        await resumeMarkedSessions({
          context: gateway,
          signal: new AbortController().signal,
          log: { warn },
        });
        if (mode === "revoked" || mode === "read-only" || mode === "foreign-session") {
          expect(resumed).toEqual([]);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped restart resume"));
        } else {
          expect(resumed, JSON.stringify(warn.mock.calls)).toEqual([
            {
              profileId: person.profile.id,
              scopes:
                mode === "own-session"
                  ? ["operator.sessions.write"]
                  : ["operator.read", "operator.write"],
            },
          ]);
        }
      } finally {
        enqueue.mockRestore();
      }
    }),
);

it("resumes the original access grant without requesting a new grant", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const original = { pluginId: "restart-access", grantId: "accepted-original" };
    let acceptNew = true;
    const grant = {
      grantId: original.grantId,
      signal: new AbortController().signal,
      assertCurrent() {},
    };
    const authorize = vi.fn(() => (acceptNew ? grant : undefined));
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: original.pluginId }));
    registry.gatewayAccessPolicies.push({
      pluginId: original.pluginId,
      source: "fixture",
      policy: { authorize, resume: () => grant },
    });
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(registry, null, "default");
    try {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: {
                scopes: ["operator.read", "operator.write"],
                agents: "*",
                sessions: { others: "write" },
                accessPolicyPlugin: original.pluginId,
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const person = ensureProfileForEmail("restart-grant@example.test");
      const fixture = await recoveryFixture(stateDir, person.id, {
        config: cfg,
        gatewayAccessGrant: original,
        scopes: ["operator.read", "operator.write"],
      });
      acceptNew = false;
      authorize.mockClear();
      const restored = expectDefined(
        await prepareSessionSystemTurnAuthority({
          context: fixture.context,
          ...fixture.target,
          operatorSource: { kind: "gateway", snapshot: fixture.snapshot },
        }),
        "restored original requester",
      );
      try {
        restored.authority.assertCurrent();
        expect(restored.authority.gatewayAccessGrant).toEqual(original);
        expect(authorize).not.toHaveBeenCalled();
      } finally {
        restored.release();
      }
    } finally {
      restoreActivePluginRegistrySnapshot(previous);
    }
  }));

it("recovers a current owner certificate independently of the linked profile's reader role", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const principal = {
      kind: "owner" as const,
      peerKey: `iroh:${"ab".repeat(32)}`,
      authority: { clawId: "claw", rootPub: "root", listedSeq: 1, ownerDevice: "owner-device" },
    };
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    try {
      const person = ensureProfileForEmail("restart-owner@example.test");
      const fixture = await recoveryFixture(stateDir, person.id, {
        config: cfg,
        scopes: ["operator.read", "operator.write"],
        openclawIdPrincipal: principal,
      });
      const restored = expectDefined(
        await prepareSessionSystemTurnAuthority({
          context: fixture.context,
          ...fixture.target,
          operatorSource: { kind: "gateway", snapshot: fixture.snapshot },
        }),
        "restored owner certificate",
      );
      try {
        expect(restored.authority.scopes).toEqual(["operator.read", "operator.write"]);
        expect(restored.authority.profileId).toBe(person.id);
        restored.authority.assertCurrent();
        setOpenClawIdTunnelPrincipalLookup(() => undefined);
        expect(() => restored.authority.assertCurrent()).toThrow();
      } finally {
        restored.release();
      }
    } finally {
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  }));
