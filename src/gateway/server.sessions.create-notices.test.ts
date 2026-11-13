import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { loseSessionSignalAcknowledgement } from "./test/session-signal-failure.test-support.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("sessions.create preserves creation and notices after an unknown signal outcome", async () => {
  const { storePath } = await createSessionStoreDir();
  const profileId = ensureProfileForEmail("session-creator@example.test").id;
  const profile = { profileId, displayName: "Test Operator" };
  const client = {
    connect: { scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: { ...profile, hasAvatar: false, updatedAt: 1 },
  };
  attachGatewayLocalUserIngress(
    client,
    prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile,
      isLocalClient: false,
    }),
  );
  const operator = { client: client as never };
  const create = (params: Record<string, unknown>, creator = operator) =>
    directSessionReq<{ key?: string; entry?: SessionEntry }>("sessions.create", params, creator);
  const syntheticClient = (sessionCreation?: TrustedSessionCreation) => ({
    client: {
      connect: { scopes: ["operator.write"] },
      internal: { syntheticClient: true, sessionCreation },
    } as never,
  });
  const signal = loseSessionSignalAcknowledgement();
  const created = await create({
    agentId: "main",
    key: "agent:main:dashboard:created-signal",
    label: "Investigate build failure",
  }).finally(signal.restore);

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: profileId },
    createdAt: expect.any(Number),
  });
  expect(created.payload?.entry).not.toHaveProperty("createdActor.label");
  const key = expectDefined(created.payload?.key, "created session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty("createdActor.label");
  expect((await listSessionStateEventsSince(key, "main", 0, 20)).events).toContainEqual(
    expect.objectContaining({
      kind: "created",
      actorType: "human",
      actorId: profileId,
      summary: "session created",
    }),
  );

  const notices = drainSystemEvents("agent:main:main");
  expect(notices).toEqual([expect.stringContaining("New session created")]);
  for (const text of ["Investigate build failure", profileId, key, "operator"]) {
    expect(notices[0]).toContain(text);
  }

  const existing = await create({ key });
  expect(existing.ok).toBe(true);
  expect(peekSystemEvents("agent:main:main")).toEqual([]);
  expect((await listSessionStateEventsSince(key, "main", 0, 20)).events).toHaveLength(1);
  const described = await directSessionReq("sessions.describe", { key }, operator);
  expect(described).toMatchObject({ ok: true, payload: { session: { key } } });

  const synthetic = await create({ agentId: "main" }, syntheticClient());
  expect(synthetic.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdAt: expect.any(Number),
  });
  expect(synthetic.payload?.entry?.createdActor).toBeUndefined();

  const human = (id: string) => ({ type: "human", source: "profile", id }) as const;
  const isolationActor = human("profile-isolation-owner");
  const causalCreator = human("profile-delegated-creator");
  const agentActor = { type: "agent", id: "main" } as const;
  const delegatedActor = { ...isolationActor, delegatedBy: causalCreator };
  for (const [actor, sandbox, expectedCreator, expectedStoredActor] of [
    [agentActor, undefined, agentActor, agentActor],
    [
      isolationActor,
      "required",
      { type: "agent" },
      { ...isolationActor, delegatedBy: { type: "agent" } },
    ],
    [delegatedActor, "required", causalCreator, delegatedActor],
  ] as const) {
    // Trusted creation hints retain causal attribution separately from required isolation.
    // A selected human isolation identity alone does not prove a human initiated the work.
    const hinted = await create(
      { agentId: "main" },
      syntheticClient({ via: "spawn", actor, sandbox, requesterSessionKey: "agent:main:main" }),
    );
    expect(hinted.ok, JSON.stringify(hinted.error)).toBe(true);
    expect(hinted.payload?.entry).toMatchObject({
      createdVia: "spawn",
      createdActor: expectedCreator,
    });
    expect(hinted.payload?.entry?.sandbox).toBe(sandbox);
    const hintedKey = expectDefined(hinted.payload?.key, "delegated session key");
    const stored = loadSessionEntry({ sessionKey: hintedKey, storePath });
    expect(stored?.createdVia).toBe("spawn");
    expect(stored?.createdActor).toEqual(expectedStoredActor);
    expect(stored?.sandbox).toBe(sandbox);
  }
});
