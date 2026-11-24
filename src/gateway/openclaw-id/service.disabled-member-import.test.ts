import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as profileAuthority from "../../state/user-channel-identity-operations.js";
import {
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readStoredClaw, writeStoredClaw } from "./claw-store.js";
import {
  checkDeviceTokenPeer,
  setDeviceTokenBindingOwner,
  setDeviceTokenBindingsLoading,
} from "./device-token-binding.js";
import { withMissingMemberRolePresets } from "./member-role-presets.js";
import {
  legacyMemberSnapshot,
  memberRoleImport,
} from "./member-source-role-import.test-support.js";
import { linkedClaw } from "./openclaw-id.test-support.js";
import { createOpenClawIdService } from "./service.js";

it.each(["startup", "profile preparation"])(
  "ID disabled during %s hydrates token bindings without importing retained member roles or saved sources",
  async (disabledDuring) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const config = {
        gateway: {
          openclawId: { enabled: disabledDuring === "profile preparation" },
          roles: { definitions: { operator: memberRoleImport.policy } },
        },
      };
      setRuntimeConfigSnapshot(config);
      const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
      const accountId = memberRoleImport.accountId;
      const peerKey = `iroh:${"a".repeat(64)}` as const;
      expect(
        await claw.authority.submit(
          await claw.sign({
            op: "add",
            account_id: accountId,
            role: "operator",
            peer_keys: [peerKey],
            invite_id: null,
          }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
      await claw.authority.bindToken("retained-browser", "operator", peerKey);
      const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({ accountId });
      await setCanonicalUserProfileRole(profile.id, null);
      const stored = (await readStoredClaw())!;
      delete stored.member_profile_roles;
      await writeStoredClaw(stored);
      const snapshot = { ...legacyMemberSnapshot(), profileId: profile.id };
      const target = {
        agentId: "main",
        sessionKey: "agent:main:disabled-id",
        sessionId: "disabled-id",
        storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        lifecycleRevision: "retained",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        lifecycleRevision: "retained",
        createdActor: { type: "human", source: "profile", id: profile.id },
        operatorSources: { [profile.id]: snapshot },
        resumeAfterRestart: { operatorSource: { kind: "gateway", snapshot } },
      });
      const before = await readSessionEntryReadOnlyInWorker(target);
      expect(before?.operatorSources?.[profile.id]).toEqual(snapshot);
      expect(before?.resumeAfterRestart?.operatorSource).toEqual({ kind: "gateway", snapshot });
      let serviceConfig = config.gateway.openclawId;
      const reached = createDeferredCore();
      const resume = createDeferredCore();
      const prepare = profileAuthority.prepareUserProfileRoleAuthority;
      using preparation =
        disabledDuring === "profile preparation"
          ? vi
              .spyOn(profileAuthority, "prepareUserProfileRoleAuthority")
              .mockImplementationOnce(async (...args) => {
                const preparedProfile = await prepare(...args);
                reached.resolve();
                await resume.promise;
                return preparedProfile;
              })
          : undefined;
      const service = createOpenClawIdService({
        getConfig: () => serviceConfig,
        getStateDir: () => stateDir,
        getGatewayServer: () => undefined,
        log: { info() {}, warn() {} },
      });
      try {
        const loading = service.loadTokenBindings();
        if (preparation) {
          await reached.promise;
          serviceConfig = { enabled: false };
          setRuntimeConfigSnapshot({
            ...config,
            gateway: { ...config.gateway, openclawId: serviceConfig },
          });
          resume.resolve();
        }
        await loading;
        expect(
          await checkDeviceTokenPeer({
            deviceId: "retained-browser",
            role: "operator",
            peerKey: undefined,
          }),
        ).toMatchObject({ ok: false, reason: "device-token-peer-mismatch" });
        expect
          .soft((await profileAuthority.prepareUserProfileRoleAuthority(profile.id))?.role)
          .toBeNull();
        expect.soft((await readStoredClaw())?.member_profile_roles).toBeUndefined();
        const entry = await readSessionEntryReadOnlyInWorker(target);
        expect.soft(entry?.operatorSources?.[profile.id]).toEqual(snapshot);
        expect
          .soft(entry?.resumeAfterRestart?.operatorSource)
          .toEqual({ kind: "gateway", snapshot });
        serviceConfig = { enabled: true };
        setRuntimeConfigSnapshot(
          withMissingMemberRolePresets({
            ...config,
            gateway: { ...config.gateway, openclawId: serviceConfig },
          }),
        );
        await service.reconcileRuntimePolicy();
        expect((await profileAuthority.prepareUserProfileRoleAuthority(profile.id))?.role).toBe(
          "operator",
        );
        expect((await readStoredClaw())?.member_profile_roles?.[accountId]).toBe(true);
        const migrated = { ...snapshot, assignedRole: "operator" };
        const enabledEntry = await readSessionEntryReadOnlyInWorker(target);
        expect(enabledEntry?.operatorSources?.[profile.id]).toEqual(migrated);
        expect(enabledEntry?.resumeAfterRestart?.operatorSource).toEqual({
          kind: "gateway",
          snapshot: migrated,
        });
      } finally {
        resume.resolve();
        await service.stop();
        setDeviceTokenBindingOwner(undefined);
        setDeviceTokenBindingsLoading(Promise.resolve());
      }
    });
  },
);
