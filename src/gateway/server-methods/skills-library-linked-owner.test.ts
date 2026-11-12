// A new session created from a linked owner device (OCF-510) is seeded with its person's library
// skills under the owner's permissions, not the person's named role; the library store needs the
// host SQLite broker, so this runs in the forked Gateway methods pool.
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "../openclaw-id/tunnel-principal.js";
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
