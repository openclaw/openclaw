import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { afterEach, expect, it } from "vitest";
import { runWithCliPreparationSource } from "../agents/cli-runner/prepare-source.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "../agents/cli-runner/types.js";
import { replyToolDiscoveryCapture } from "../auto-reply/reply/reply-tool-discovery-capture.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  assignSessionOwner,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { normalizeSessionToolDiscovery } from "../config/sessions/tool-discovery.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SkillLibraryRequestOwner } from "./server-methods/skills-library.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { prepareGatewaySkillAuthoring } from "./skill-library-authoring.js";
import { captureGatewayToolDiscovery, prepareSessionToolDiscovery } from "./tool-discovery.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const sessionKey = "agent:main:discovery";
const sessionId = "discovery-incarnation";
afterEach(() => clearRuntimeConfigSnapshot());

async function withFixture(
  run: (fixture: {
    config: OpenClawConfig;
    scope: { agentId: string; sessionKey: string; storePath: string };
    owner: SkillLibraryRequestOwner;
    profileId: string;
    capture: () => Promise<NonNullable<ReturnType<typeof captureGatewayToolDiscovery>>>;
    prepare: (
      capture?: ReturnType<typeof captureGatewayToolDiscovery>,
    ) => ReturnType<typeof prepareSessionToolDiscovery>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", sessionKey, storePath: state.statePath("sessions.sqlite") };
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: scope.storePath },
      gateway: {
        roles: {
          default: "admin",
          definitions: {
            admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "view" } },
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const profile = ensureProfileForEmail("author@example.test");
    const catalog = await prepareUserProfileCatalog();
    try {
      await replaceSessionEntry(scope, { sessionId, lifecycleRevision: "first", updatedAt: 1 });
      const owner: SkillLibraryRequestOwner = {
        client: {
          authenticatedUserProfile: { profileId: profile.id },
          connect: { scopes: ["operator.admin"] },
          internal: { controlUiAdmin: true },
        } as SkillLibraryRequestOwner["client"],
        context: { getRuntimeConfig: () => config } as SkillLibraryRequestOwner["context"],
      };
      const capture = async () =>
        captureGatewayToolDiscovery(
          owner,
          true,
          await prepareGatewaySkillAuthoring(owner, sessionKey, true),
        )!;
      const prepare = (captured?: ReturnType<typeof captureGatewayToolDiscovery>) =>
        prepareSessionToolDiscovery({
          ...scope,
          sessionId,
          getConfig: () => config,
          capture: captured,
          assertCurrent() {},
        });
      await run({ config, scope, owner, profileId: profile.id, capture, prepare });
    } finally {
      catalog.release();
    }
  });
}

it("reacquires durable declarations after closing storage without recovering personal authority", async () => {
  await withFixture(async ({ capture, prepare }) => {
    const human = await prepare(await capture());
    expect(human.presentation).toEqual({
      workshop: { defaultTarget: "workspace", multipleProfiles: false },
      automations: "management",
    });
    human.assertCurrent(); // Own commit must not revoke its retained reader.
    human[Symbol.dispose]();
    await closeOpenClawAgentDatabasesAsync();
    using cold = await prepare();
    expect(cold.presentation).toEqual({
      workshop: { defaultTarget: "workspace", multipleProfiles: false },
      automations: "management",
    });
    expect(JSON.stringify(cold.presentation)).not.toMatch(
      /profileId|profileFactsKey|audienceKey|scopes/,
    );
    cold.assertCurrent();
  });
});

it("invalidates an admitted presentation when a later human replaces or clears it", async () => {
  await withFixture(async ({ owner, capture, prepare }) => {
    using first = await prepare(await capture());
    owner.client!.connect.scopes = ["operator.read"];
    using ordinary = await prepare(await capture());
    expect(ordinary.presentation).toMatchObject({
      automations: "ordinary",
      workshop: { defaultTarget: "personal" },
    });
    expect(() => first.assertCurrent()).toThrow();
    owner.client!.authenticatedUserProfile = undefined;
    using cleared = await prepare(captureGatewayToolDiscovery(owner, true, undefined));
    expect(cleared.presentation).toBeUndefined();
    expect(() => ordinary.assertCurrent()).toThrow();
    using resumed = await prepare();
    expect(resumed.presentation).toBeUndefined();
  });
});

it("rejects saved declarations after role, account, audience, or incarnation changes", async () => {
  await withFixture(async ({ scope, profileId, capture, prepare }) => {
    const save = async () => {
      using saved = await prepare(await capture());
      saved.assertCurrent();
    };
    const absent = async () => {
      using stale = await prepare();
      expect(stale.presentation).toBeUndefined();
    };
    await save();
    setUserProfileRole(profileId, "reader");
    await absent();
    await save();
    linkEmail("another@example.test", profileId);
    await absent();
    await save();
    await addSessionMember(scope, { identityId: "different-reader", addedBy: profileId });
    await absent();
    await save();
    await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "reset" }));
    await absent();
    await replaceSessionEntry(scope, { sessionId: "successor", updatedAt: 2 });
    await absent();
  });
});

it("keeps presentation and admitted runs across unrelated profile and audience changes", async () => {
  await withFixture(async ({ scope, profileId, capture, prepare }) => {
    using prepared = await prepare(await capture());
    // Another resident profile does not change this requester's saved presentation.
    ensureProfileForEmail("unrelated@example.test");
    using resumed = await prepare();
    expect(resumed.presentation).toEqual(prepared.presentation);
    prepared.completePreparation();
    await addSessionMember(scope, { identityId: "later-member", addedBy: profileId });
    // Presentation staleness fences preparation only, never the admitted execution.
    expect(() => prepared.assertCurrent()).not.toThrow();
  });
});

it("does not let a channel human turn inherit another requester's presentation", async () => {
  await withFixture(async ({ capture, prepare }) => {
    using admin = await prepare(await capture());
    expect(admin.presentation?.automations).toBe("management");
    const channelHuman = replyToolDiscoveryCapture(undefined, {}, true).toolDiscoveryCapture;
    using channelTurn = await prepare(channelHuman);
    expect(channelTurn.presentation).toBeUndefined();
    using laterBackground = await prepare();
    expect(laterBackground.presentation).toBeUndefined();
  });
});

it("clears instead of aborting when a retried capture outlives its requester facts", async () => {
  await withFixture(async ({ profileId, capture, prepare }) => {
    const captured = await capture();
    using first = await prepare(captured);
    expect(first.presentation?.automations).toBe("management");
    setUserProfileRole(profileId, "reader");
    // Model fallback and overflow retries prepare again with the ingress capture.
    using retry = await prepare(captured);
    expect(retry.presentation).toBeUndefined();
    using later = await prepare();
    expect(later.presentation).toBeUndefined();
  });
});

it("does not fence an admitted CLI run on later presentation changes", async () => {
  await withFixture(async ({ config, scope, profileId, capture }) => {
    let runAssertCurrent: (() => void) | undefined;
    await runWithCliPreparationSource(
      {
        sessionKey,
        sessionId,
        agentId: "main",
        storePath: scope.storePath,
        config,
        toolDiscoveryCapture: await capture(),
        // SAFETY: Discovery preparation reads only these session and capture fields.
      } as RunCliAgentParams,
      async (params) => {
        expect(params.toolDiscovery?.automations).toBe("management");
        runAssertCurrent = params.assertCurrent;
        // SAFETY: The wrapper only sequences this prepared backend's cleanup.
        return { preparedBackend: {} } as PreparedCliRunContext;
      },
    );
    ensureProfileForEmail("unrelated@example.test");
    await addSessionMember(scope, { identityId: "later-member", addedBy: profileId });
    expect(() => runAssertCurrent?.()).not.toThrow();
  });
});

it("does not commit discovery across a queued same-store owner reassignment", async () => {
  await withFixture(async ({ config, scope, capture, prepare }) => {
    const captured = await capture();
    const delivery = getSessionEntryPatchDelivery();
    let changed = false;
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      expect(
        assignSessionOwner(scope, {
          owner: { type: "human", id: "replacement-owner" },
          assignedBy: { type: "system", id: "owner-race-fixture" },
          assignedAt: 42,
        }),
      ).not.toBeNull();
      changed = true;
    };
    await expect(prepare(captured)).rejects.toThrow();
    expect(changed).toBe(true);
    const current = await prepareSessionMutationFacts({ cfg: config, ...scope });
    try {
      const entry = current.readCurrent(config).target.entry;
      expect(entry.owner?.actor).toEqual({ type: "human", id: "replacement-owner" });
      expect(entry.toolDiscovery).toBeUndefined();
    } finally {
      current.release();
    }
  });
});

it("ignores legacy, malformed, and unbounded imported presentation records", async () => {
  const record = {
    version: 1,
    sessionId,
    profileId: "profile",
    profileFactsKey: "a".repeat(64),
    audienceKey: "b".repeat(64),
    presentation: { automations: "ordinary" },
  };
  expect(normalizeSessionToolDiscovery(record)).toEqual(record);
  for (const unsupportedId of ["", "x".repeat(513)]) {
    using legacy = await prepareSessionToolDiscovery({
      agentId: "main",
      sessionKey,
      sessionId: unsupportedId,
      getConfig: () => {
        throw new Error("Legacy presentation must not open storage");
      },
      assertCurrent() {},
    });
    expect(legacy.presentation).toBeUndefined();
  }
  for (const malformed of [
    undefined,
    { ...record, version: 2 },
    { ...record, sessionId: "" },
    { ...record, profileId: "x".repeat(10000) },
    { ...record, profileFactsKey: "not-a-signature" },
    { ...record, presentation: { automations: "admin" } },
  ]) {
    expect(normalizeSessionToolDiscovery(malformed)).toBeUndefined();
  }
});
