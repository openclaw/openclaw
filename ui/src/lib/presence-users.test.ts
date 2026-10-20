import { expect, it } from "vitest";
import {
  hasSessionPresenceViewers,
  presenceUserLabel,
  presenceViewerActivity,
  projectOnlinePresenceViewers,
  projectPresencePayload,
  projectPresenceViewers,
} from "./presence-users.ts";

it.each([
  [{ id: "gateway-owner" }, { name: "Shared owner", isSharedOwner: true }],
  [
    { id: "gateway-owner", name: "Saved owner name" },
    { name: "Shared owner", isSharedOwner: true },
  ],
  [
    { id: "person", name: "Example person", email: "person@example.test" },
    { name: "Example person", isSharedOwner: false },
  ],
  [
    { id: "person", email: "person@example.test" },
    { name: "person@example.test", isSharedOwner: false },
  ],
  [{ id: "person" }, { name: "person", isSharedOwner: false }],
])("labels presence without presenting the shared identity as a person: %j", (user, expected) => {
  expect(presenceUserLabel(user)).toEqual(expected);
});

it("isolates namespaces while merging renamed tabs and excluding disconnected facts", () => {
  const id = "synthetic-shared-id";
  const profile = { id, identity: { type: "profile" as const, id }, name: "Profile person" };
  const raw = { id, name: "Unqualified sender" };
  const presence = [
    { instanceId: "profile-tab", user: profile, watchedSessions: ["profile-session"] },
    { instanceId: "raw-tab", user: raw, watchedSessions: ["raw-session"] },
    {
      instanceId: "profile-tab-2",
      user: { ...profile, name: "Renamed profile" },
      watchedSessions: ["profile-extra"],
    },
    {
      instanceId: "raw-tab-2",
      user: { ...raw, name: "Updated raw" },
      watchedSessions: ["raw-extra"],
    },
    { instanceId: "closed", user: raw, reason: "disconnect", watchedSessions: ["closed-session"] },
  ];
  const forward = projectPresencePayload({ presence });
  expect(forward.users).toHaveLength(2);
  expect(
    forward.users.map(({ id: userId, identity, name, watchedSessions, entries }) => [
      userId,
      identity,
      name,
      watchedSessions,
      entries?.length,
    ]),
  ).toEqual([
    [id, profile.identity, profile.name, ["profile-extra", "profile-session"], 2],
    [id, undefined, raw.name, ["raw-extra", "raw-session"], 2],
  ]);
  expect(projectPresencePayload({ presence: presence.toReversed() })).toEqual(forward);
});

it.each([true, false])(
  "excludes self only from session viewers, not the online roster (profile: %s)",
  (qualified) => {
    const id = "synthetic-shared-id";
    const profile = { id, identity: { type: "profile" as const, id }, name: "Same label" };
    const raw = { id, identity: undefined, name: "Same label" };
    const payload = {
      presence: [
        { instanceId: "profile-tab", user: profile, watchedSessions: ["profile-session"] },
        { instanceId: "raw-tab", user: raw, watchedSessions: ["raw-session"] },
      ],
    };
    const self = qualified ? profile : raw;
    const other = qualified ? raw : profile;
    const instance = qualified ? "profile-tab" : "raw-tab";
    const otherSession = qualified ? "raw-session" : "profile-session";
    const selfSession = qualified ? "profile-session" : "raw-session";
    // An unchanged payload must still exclude the current self qualification.
    projectPresenceViewers(payload, other);
    for (const [explicitSelf, fallbackInstance] of [
      [self, undefined],
      [undefined, instance],
      [self, qualified ? "raw-tab" : "profile-tab"],
    ] as const) {
      const viewers = projectPresenceViewers(payload, explicitSelf, fallbackInstance);
      expect(viewers).toHaveLength(1);
      expect(viewers[0]?.identity).toEqual(other.identity);
      expect(hasSessionPresenceViewers(payload, explicitSelf, fallbackInstance, otherSession)).toBe(
        true,
      );
      expect(hasSessionPresenceViewers(payload, explicitSelf, fallbackInstance, selfSession)).toBe(
        false,
      );
    }
    expect(projectOnlinePresenceViewers(payload).map((user) => user.identity)).toEqual([
      profile.identity,
      undefined,
    ]);
    expect(projectPresenceViewers(payload, null, instance).map((user) => user.identity)).toEqual([
      profile.identity,
      undefined,
    ]);
  },
);

it.each([
  { type: "profile" as const, id: "same" },
  { type: "agent" as const, id: "same" },
  { type: "legacy" as const, actorType: "human", source: "channel", id: "same" },
  undefined,
])("deduplicates only a rendered profile owner: %j", (identity) => {
  const payload = {
    presence: [
      {
        user: { id: "same", identity: { type: "profile" as const, id: "same" } },
        watchedSessions: ["session"],
      },
      { user: { id: "same" }, watchedSessions: ["session"] },
    ],
  };
  const viewers = projectPresenceViewers(
    payload,
    undefined,
    undefined,
    "session",
    identity ? [identity] : [],
  );
  expect(viewers.map((user) => user.identity)).toEqual(
    identity?.type === "profile" ? [undefined] : [payload.presence[0]!.user.identity, undefined],
  );
});

it("ages person interaction independently of connection beacons and native input recency", () => {
  const now = 1_000_000;
  type Entry = NonNullable<Parameters<typeof presenceViewerActivity>[0]["entries"]>[number];
  const activity = (...entries: Entry[]) =>
    presenceViewerActivity({ id: "person", watchedSessions: [], entries }, now);
  const at = (age: number) => ({ ts: now, lastActivityAt: now - age });
  expect(activity({ ts: now, lastInputSeconds: 0 })).toBe("unknown");
  expect(activity(at(120_000))).toBe("idle");
  expect(activity(at(119_999))).toBe("active");
  expect(activity(at(600_000), at(5_000), { ts: now })).toBe("active");
  expect(activity(at(600_000), { ...at(0), reason: "disconnect" })).toBe("idle");
});
