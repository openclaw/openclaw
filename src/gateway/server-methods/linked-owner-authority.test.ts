// A linked owner device (OCF-510) keeps owner authority under its person's profile through
// stored-role changes, and seeds new sessions with the person's library skills under the owner's
// permissions. These write the profile database through the host SQLite broker, so they run in
// the forked Gateway methods pool.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "../openclaw-id/tunnel-principal.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { dispatchProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";

const temps = useSessionStoreTempDirs(afterAll, "linked-owner-library-");
const OWNER: OpenClawIdTunnelPrincipal = { kind: "owner", peerKey: `iroh:${"3c".repeat(32)}` };
// Every person defaults to a role that cannot read the skill library.
const cfg: OpenClawConfig = {
  gateway: {
    roles: {
      default: "talker",
      definitions: {
        talker: { scopes: ["operator.talk"], agents: [], sessions: { others: "none" } },
      },
    },
  },
};
let stateDir: string | undefined;

beforeEach(() => {
  setOpenClawIdTunnelPrincipalLookup((peerKey) => (peerKey === OWNER.peerKey ? OWNER : undefined));
});

afterEach(async () => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
  if (stateDir) {
    await cleanupSessionStateForTest({ stateDir });
    stateDir = undefined;
  }
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("seeds a linked owner's new session with the person's library skills", async () => {
  stateDir = temps.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const person = ensureProfileForEmail("linked-owner-skills@example.test");
  using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
  // Saved while the person could still write to their library.
  const saved = await saveSkillLibrary(
    {
      profileId: person.id,
      scopes: ["operator.read", "operator.write"],
      getConfig: () => ({}),
      assertCurrent: () => {},
    },
    {
      slug: "owner-procedure",
      content: "---\nname: owner-procedure\ndescription: Owner procedure\n---\n# Steps\n",
      expectedRevision: null,
    },
  );
  const socket = (principal?: OpenClawIdTunnelPrincipal) =>
    ({
      connId: "c1",
      connect: { role: "operator", scopes: ["operator.admin"] },
      authenticatedUserProfile: { profileId: person.id },
      internal: principal ? { openclawIdPrincipal: principal } : {},
    }) as unknown as Parameters<typeof prepareSkillLibrarySessionCreation>[0];
  const seeded = async (principal?: OpenClawIdTunnelPrincipal) =>
    (await prepareSkillLibrarySessionCreation(socket(principal), cfg, { via: "create" } as never))
      .skillLibrarySelections ?? [];
  expect((await seeded(OWNER)).map((pin) => pin.skillId)).toEqual([saved.entry.skillId]);
  // The person's own connection is held to their role, which cannot read the library.
  expect(await seeded()).toEqual([]);
});

it("keeps a linked owner's accepted work when the person's stored role changes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const person = ensureProfileForEmail("linked-owner-run@example.test");
    const context = createDirectChatContext({
      getRuntimeConfig: () => ({}),
      getCommittedRuntimeConfig: () => ({}),
    });
    const capture = async (principal?: OpenClawIdTunnelPrincipal) =>
      expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: {
            connId: `run-${principal?.kind ?? "person"}`,
            connectionSignal: new AbortController().signal,
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: {
                id: "openclaw-control-ui",
                version: "dev",
                platform: "test",
                mode: "webchat",
              },
              role: "operator",
              scopes: ["operator.admin"],
            },
            authenticatedUserProfile: dispatchProfile(person.id),
            internal: {
              authenticatedOperator: true,
              operatorRoleActor: principal
                ? { kind: "system" }
                : { kind: "operator", profileId: person.id },
              ...(principal ? { openclawIdPrincipal: principal } : {}),
            },
          } as unknown as GatewayWsClient,
          context,
        }),
        "captured run authority",
      );
    const owner = await capture(OWNER);
    const personal = await capture();
    // users.setRole persists the role, then publishes a role-only change.
    await setCanonicalUserProfileRole(person.id, "reader", {
      onCommitted: (id) => invalidateOperatorRolePolicy(id, { roleOnly: true }),
    });
    expect(owner.authority.signal?.aborted).toBe(false);
    expect(() => owner.authority.assertCurrent()).not.toThrow();
    // The person's own work follows their role.
    expect(personal.authority.signal?.aborted).toBe(true);
    // An identity change, such as a merge, still ends the owner's attributed work.
    invalidateOperatorRolePolicy(person.id);
    expect(owner.authority.signal?.aborted).toBe(true);
    owner.release();
    personal.release();
  }));
