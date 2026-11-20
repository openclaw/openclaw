import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalOpenClawIdUserProfile,
  setCanonicalUserProfileRole,
  unlinkCanonicalOpenClawIdUserProfile,
} from "../state/user-profile-writes.js";
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
import { recoveryFixture } from "./operator-run-recovery.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

const reader: GatewayOperatorRoleDefinition = {
  scopes: ["operator.read"],
  agents: ["main"],
  sessions: { others: "none" as const },
};
const config: OpenClawConfig = {
  gateway: { openclawId: { enabled: true }, roles: { definitions: { reader } } },
};
afterEach(() => setOpenClawIdMemberAccountLookup(undefined));

it("keeps the global default switch separate from per-person catalog enforcement", () => {
  for (const member of [false, true]) {
    const subject = { profileId: "person", openclawIdMember: member };
    expect(isOperatorRoleEnforcedFor({}, subject)).toBe(false);
    expect(isNamedOperatorRoleEnforcementEnabled(config)).toBe(false);
    expect(isOperatorRoleEnforcedFor(config, subject)).toBe(member);
    expect(isOperatorRoleEnforcedFor({ gateway: { roles: { default: "reader" } } }, subject)).toBe(
      true,
    );
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
      expect(resolveOperatorRolePolicyForProfile(profile.id, config)).toBeUndefined();
      members.add("member");
      expect(operatorRoleSubject(prepared)).toEqual({
        profileId: profile.id,
        openclawIdMember: true,
      });
      expect(resolveOperatorRolePolicyForProfile(profile.id, config)).toEqual(reader);
      expect(
        resolveOperatorRolePolicyForProfile(profile.id, {
          gateway: { openclawId: { enabled: true } },
        })?.scopes,
      ).toEqual([]);
      expect(
        resolveOperatorRolePolicyForAssignment(
          profile.id,
          null,
          config,
          null,
          operatorRoleSubject(prepared),
        )?.scopes,
      ).toEqual([]);
      members.delete("member");
      expect(resolveOperatorRolePolicyForProfile(profile.id, config)).toBeUndefined();
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
    expect(resolveOperatorRolePolicyForProfile(profile.id, config)).toBeUndefined();
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
      const role = { ...reader, sandbox: "required" as const };
      const cfg: OpenClawConfig = {
        gateway: { openclawId: { enabled: true }, roles: { definitions: { reader: role } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const fixture = await recoveryFixture(stateDir, profile.id, {
        config: cfg,
        scopes: ["operator.read"],
      });
      const recovered = await fixture.restore();
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
          expect(recovered.authority.reauthorize).toThrow(
            "Restart recovery operator source policy changed",
          );
        }
      } finally {
        recovered.release();
      }
    });
  });
}

it("rechecks a retained PR audience after membership-only admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createPrFixture("operator.read");
    try {
      await linkCanonicalOpenClawIdUserProfile({
        profileId: fixture.profile.id,
        accountId: "pr-reader",
        email: null,
      });
      const cfg = structuredClone(fixture.cfg);
      cfg.gateway!.openclawId = { enabled: true };
      delete cfg.gateway!.roles!.default;
      cfg.gateway!.roles!.definitions.reader!.sessions.others = "none";
      setRuntimeConfigSnapshot(cfg);
      prepareGatewayRecipientProfile(fixture.client);
      let member = false;
      setOpenClawIdMemberAccountLookup((accountId) => member && accountId === "pr-reader");
      const sessionKey = "agent:main:member-audience";
      await fixture.seed(sessionKey, fixture.other.id, { visibility: "shared" });
      await fixture.subscribe([sessionKey]);
      const read = createControlUiSessionPrRead({
        client: fixture.client,
        sessionKey,
        getRuntimeConfig: fixture.context.getRuntimeConfig,
        getSessionRowProjection: () => getSessionRowProjection(fixture.context),
        isCurrentClient: () => !fixture.client.invalidated,
      });
      expect(read).toBeDefined();
      const target = await read?.();
      expect(target).toBeDefined();
      expect(await read?.()).toBe(target);
      member = true;
      expect(await read?.()).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
