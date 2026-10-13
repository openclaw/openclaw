import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { loseSessionSignalAcknowledgement } from "./test/session-signal-failure.test-support.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("sessions.create preserves creation and notices after an unknown signal outcome", async () => {
  const { storePath } = await createSessionStoreDir();
  const profileId = ensureProfileForEmail("session-creator@example.test").id;
  const client = {
    connect: { scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: {
      profileId,
      displayName: "Test Operator",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  attachGatewayLocalUserIngress(
    client,
    prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId, displayName: "Test Operator" },
      isLocalClient: false,
    }),
  );
  const signal = loseSessionSignalAcknowledgement();
  const created = await directSessionReq<{
    key?: string;
    entry?: {
      createdVia?: string;
      createdActor?: { type: string; id?: string };
      createdAt?: number;
    };
  }>(
    "sessions.create",
    {
      agentId: "main",
      key: "agent:main:dashboard:created-signal",
      label: "Investigate build failure",
    },
    { client: client as never },
  ).finally(signal.restore);

  expect(created.ok).toBe(true);
  expect(signal.attempts()).toBe(1);
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
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("New session created");
  expect(notices[0]).toContain("Investigate build failure");
  expect(notices[0]).toContain(profileId);
  expect(notices[0]).toContain(key);
  expect(notices[0]).toContain("operator");

  const existing = await directSessionReq("sessions.create", { key }, { client: client as never });
  expect(existing.ok).toBe(true);
  expect(peekSystemEvents("agent:main:main")).toEqual([]);
  expect((await listSessionStateEventsSince(key, "main", 0, 20)).events).toHaveLength(1);
  const described = await directSessionReq<{ session: { key: string } }>(
    "sessions.describe",
    { key },
    { client: client as never },
  );
  expect(described.ok).toBe(true);
  expect(described.payload?.session).toMatchObject({ key });

  const synthetic = await directSessionReq<{
    entry?: { createdVia?: string; createdActor?: unknown; createdAt?: number };
  }>(
    "sessions.create",
    { agentId: "main" },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: { syntheticClient: true },
      } as never,
    },
  );
  expect(synthetic.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdAt: expect.any(Number),
  });
  expect(synthetic.payload?.entry?.createdActor).toBeUndefined();

  for (const { actor, sandbox } of [
    { actor: { type: "agent", id: "main" }, sandbox: undefined },
    {
      actor: { type: "human", source: "profile", id: "profile-delegated-creator" },
      sandbox: "required",
    },
  ] as const) {
    // The required parent's creation policy survives removal of gateway.roles.
    const hinted = await directSessionReq<{
      key?: string;
      entry?: { createdVia?: string; createdActor?: unknown; sandbox?: "required" };
    }>(
      "sessions.create",
      { agentId: "main" },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            syntheticClient: true,
            sessionCreation: {
              via: "spawn",
              actor,
              sandbox,
              requesterSessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );
    expect(hinted.ok, JSON.stringify(hinted.error)).toBe(true);
    expect(hinted.payload?.entry).toMatchObject({ createdVia: "spawn", createdActor: actor });
    expect(hinted.payload?.entry?.sandbox).toBe(sandbox);
    const hintedKey = expectDefined(hinted.payload?.key, "delegated session key");
    const stored = loadSessionEntry({ sessionKey: hintedKey, storePath });
    expect(stored).toMatchObject({ createdVia: "spawn", createdActor: actor });
    expect(stored?.sandbox).toBe(sandbox);
  }
});
