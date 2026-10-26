import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as modelPresentation from "./operator-model-presentation.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";

it("preserves shared ancestor references across staggered roster reads and first admission", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const profile = ensureProfileForEmail("row-delta-polling@example.test");
    const parent = "agent:main:parent";
    const child = "agent:main:child";
    for (const [key, label, updatedAt, parentSessionKey] of [
      [parent, "Parent", 1, undefined],
      [child, "Child", 2, parent],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: key, label, updatedAt, visibility: "shared", parentSessionKey },
      );
    }
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "row-delta-polling",
      cfg,
    });
    const context = requestContext(cfg);
    context.forgetConnectionAncestors = connection.forgetConnectionAncestors;
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const detach = connection.attachSessionRowProjection(projection);
    const peers = Array.from({ length: 4 }, (_, index) => {
      const peer = createSessionRowEventPeer(profile, `polling-${index}`, 1);
      peer.client.connect.caps = ["session-row-deltas"];
      if (index >= 2) {
        peer.client.connect.caps.push("session-event-field-refs");
      }
      connection.clients.add(peer.client);
      connection.sessionEventSubscribers.subscribe(peer.client.connId);
      const decoder = new GatewayChatEvents(() => {
        throw new Error("Unexpected missing row baseline");
      });
      return Object.assign(peer, { decoder });
    });
    const publish = () =>
      connection.broadcastToConnIds(
        "sessions.changed",
        { sessionKey: child, agentId: "main", reason: "send" },
        new Set(peers.map((peer) => peer.client.connId)),
      );
    const frameFor = (peer: (typeof peers)[number]) =>
      JSON.parse(peer.send.mock.lastCall![0]) as EventFrame;
    try {
      publish();
      // The socket admits this row before a roster listener or its first list exists.
      for (const peer of peers) {
        peer.decoder.dispatch(frameFor(peer));
      }
      publish();
      const initial = frameFor(peers[0]!).payload as {
        ancestorSessionRefs: Array<{ revision: string }>;
      };
      const revision = initial.ancestorSessionRefs[0]!.revision;
      for (const peer of peers) {
        peer.decoder.dispatch(frameFor(peer));
      }
      for (const reader of [...peers, peers[0]!]) {
        const result = await reader.decoder.request<SessionsListResult>(
          {
            request: async <T>() =>
              (await listSessions({
                client: reader.client,
                context,
                request: { agentId: "main", limit: 1 },
              })) as T,
          },
          "sessions.list",
          { agentId: "main", limit: 1 },
        );
        expect(result.sessions.map((row) => row.key)).toEqual([child]);
        publish();
        for (const peer of peers) {
          const frame = frameFor(peer);
          expect(frame.payload).toMatchObject({
            ancestorSessions: [],
            ancestorSessionRefs: [{ key: parent, revision }],
          });
          let decoded: EventFrame | undefined;
          peer.decoder.dispatch(frame, (event) => {
            decoded = event;
          });
          expect(decoded?.payload).toMatchObject({
            session: { key: child, label: "Child" },
            ancestorSessions: [{ key: parent, sessionId: parent, label: "Parent" }],
          });
          expect(decoded?.payload).not.toHaveProperty("ancestorSessionRefs");
        }
      }
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

it("shares recipient encodings only for matching authority and delivered baselines", async () => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    cfg.agents = { entries: { main: {} } };
    const owner = ensureProfileForEmail("row-delta-owner@example.test");
    const viewer = ensureProfileForEmail("row-delta-viewer@example.test");
    setUserProfileRole(owner.id, "view");
    setUserProfileRole(viewer.id, "view");
    const key = "agent:main:row-delta-audiences";
    const write = (label: string) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "same-generation",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: owner.id },
          label,
        },
      );
    write("Before");
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "row-delta-audiences",
      cfg,
    });
    const detach = connection.attachSessionRowProjection(projection);
    // Matching recipients are separated by different histories, capabilities, and authority.
    const peers = [0, 1].flatMap((copy) =>
      ["current", "stale"].flatMap((baseline) =>
        ["delta", "refs", "legacy"].flatMap((capability) =>
          [owner, viewer].map((profile) => {
            const id = `${copy}-${baseline}-${capability}-${profile.id}`;
            const peer = createSessionRowEventPeer(profile, id, 1);
            peer.client.connect.caps =
              capability === "legacy"
                ? []
                : [
                    "session-row-deltas",
                    ...(capability === "refs" ? ["session-event-field-refs"] : []),
                  ];
            connection.clients.add(peer.client);
            connection.sessionEventSubscribers.subscribe(id);
            const decoder = new GatewayChatEvents(() => {
              throw new Error("Unexpected missing row baseline");
            });
            return Object.assign(peer, { decoder, profile, baseline, capability, copy });
          }),
        ),
      ),
    );
    const publish = (ids: string[]) =>
      connection.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey: key,
          agentId: "main",
          reason: "rename",
          ["__proto__"]: { fixture: "own-data-property" },
        },
        new Set(ids),
      );
    const decodeLast = (peer: (typeof peers)[number]) => {
      const frame = JSON.parse(peer.send.mock.lastCall![0]) as EventFrame;
      let decoded: EventFrame | undefined;
      peer.decoder.dispatch(frame, (event) => {
        decoded = event;
      });
      return decoded?.payload;
    };
    const prime = (selected: typeof peers, label: string) => {
      const previousSends = selected.map((peer) => peer.send.mock.calls.length);
      publish(selected.map((peer) => peer.client.connId));
      for (const [index, peer] of selected.entries()) {
        expect(peer.send).toHaveBeenCalledTimes(previousSends[index]! + 1);
        expect(decodeLast(peer)).toMatchObject({
          session: { label },
        });
      }
    };
    try {
      prime(
        peers.filter((peer) =>
          peer.capability === "legacy" ? peer.copy === 0 : peer.baseline === "stale",
        ),
        "Before",
      );
      write("After");
      await projection.ensureMaterialized();
      prime(
        peers.filter((peer) => peer.capability !== "legacy" && peer.baseline === "current"),
        "After",
      );
      // Every delta socket has version 1, but the stale sockets contain a different label.
      for (const peer of peers.filter((value) => value.capability !== "legacy")) {
        expect(JSON.parse(peer.send.mock.lastCall![0]).payload.session.version).toBe(1);
      }
      const previousSends = peers.map((peer) => peer.send.mock.calls.length);
      const fieldEnumerations = new Map<object, number>();
      let envelopeEnumerations = 0;
      let fieldNameInsertions = 0;
      // oxlint-disable-next-line typescript/unbound-method -- The observer calls add with its original Set receiver.
      const add = Set.prototype.add;
      const adding = vi.spyOn(Set.prototype, "add").mockImplementation(function (
        this: Set<unknown>,
        value: unknown,
      ) {
        if (value === "sharingRole") {
          fieldNameInsertions++;
        }
        return add.call(this, value);
      });
      const entries = Object.entries;
      const enumerating = vi.spyOn(Object, "entries").mockImplementation((value) => {
        if (isRecord(value) && value.sessionKey === key && isRecord(value.session)) {
          envelopeEnumerations++;
        }
        if (isRecord(value) && value.key === key && typeof value.sharingRole === "string") {
          fieldEnumerations.set(value, (fieldEnumerations.get(value) ?? 0) + 1);
        }
        return entries(value);
      });
      const stringify = JSON.stringify;
      let rowEncodings = 0;
      let envelopeEncodings = 0;
      let sharingKeyEncodings = 0;
      const encoding = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
        const value: unknown = args[0];
        if (
          Array.isArray(value) &&
          value.length === 10 &&
          isRecord(value[0]) &&
          value[0].kind === "operator"
        ) {
          sharingKeyEncodings++;
        }
        if (isRecord(value) && value.key === key && typeof value.version === "number") {
          rowEncodings++;
        }
        if (isRecord(value) && isRecord(value.payload) && value.payload.sessionKey === key) {
          envelopeEncodings++;
        }
        return stringify(...args);
      });
      try {
        publish(peers.map((peer) => peer.client.connId));
      } finally {
        encoding.mockRestore();
        enumerating.mockRestore();
        adding.mockRestore();
      }
      const decodedPayloads: unknown[] = [];
      for (const [index, peer] of peers.entries()) {
        expect(peer.send).toHaveBeenCalledTimes(previousSends[index]! + 1);
        const decoded = decodeLast(peer);
        decodedPayloads.push(decoded);
        expect(decoded).toMatchObject({
          sessionKey: key,
          label: "After",
          sharingRole: peer.profile === owner ? "owner" : "viewer",
          session: {
            key,
            sessionId: "same-generation",
            label: "After",
            sharingRole: peer.profile === owner ? "owner" : "viewer",
          },
        });
        const payload = JSON.parse(peer.send.mock.lastCall![0]).payload;
        expect(Object.getOwnPropertyDescriptor(payload, "__proto__")?.value).toEqual({
          fixture: "own-data-property",
        });
        if (peer.capability === "refs") {
          expect(payload.sessionFieldRefs).toEqual(expect.any(Array));
          expect(payload).not.toHaveProperty("label");
        } else {
          expect(payload).not.toHaveProperty("sessionFieldRefs");
          expect(payload).toHaveProperty("label", "After");
        }
      }
      for (const [index, peer] of peers.entries()) {
        const legacy = peers.findIndex(
          (candidate) => candidate.profile === peer.profile && candidate.capability === "legacy",
        );
        expect(decodedPayloads[index]).toEqual(decodedPayloads[legacy]);
      }
      const beforeRevocation = peers.map((peer) => peer.send.mock.calls.length);
      peers[0]!.send.mockImplementationOnce(() => {
        for (const peer of peers) {
          if (peer.profile === viewer) {
            peer.client.connect.scopes = [];
          }
        }
      });
      publish(peers.map((peer) => peer.client.connId));
      for (const [index, peer] of peers.entries()) {
        const visible = peer.profile === owner;
        expect(peer.send).toHaveBeenCalledTimes(beforeRevocation[index]! + Number(visible));
        if (visible) {
          expect(decodeLast(peer)).toMatchObject({
            session: { label: "After", sharingRole: "owner" },
          });
        }
      }
      // The full row's field ordering is shared even when delivery baselines differ.
      expect([...fieldEnumerations.values()]).toEqual([1, 1]);
      // Referenced fields must not allocate entry tuples just to discard them.
      expect(envelopeEnumerations).toBe(0);
      // Field names are indexed once per audience, not inserted into a Set per history.
      expect(fieldNameInsertions).toBe(0);
      // Eight current delta recipients were primed at this revision; sixteen were not.
      expect(sharingKeyEncodings).toBe(16);
      // Four authority/baseline groups share row planning across both delta capabilities.
      expect(rowEncodings).toBeLessThanOrEqual(16);
      // Two wire capabilities per group, plus one legacy envelope per authority.
      expect(envelopeEncodings).toBeLessThanOrEqual(10);
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

it("prepares model presentation once per audience at growing fanout", async () => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    cfg.agents = { entries: { main: {} } };
    cfg.gateway!.roles!.definitions.view!.modelPolicy = { allow: ["fixture/visible"] };
    const profile = ensureProfileForEmail("fanout@example.test");
    setUserProfileRole(profile.id, "view");
    const key = "agent:main:fanout";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "fanout",
        updatedAt: 1,
        visibility: "shared",
        modelProvider: "fixture",
        model: "hidden",
        fastMode: "ultrafast",
      },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "fanout",
      cfg,
    });
    const detach = connection.attachSessionRowProjection(projection);
    using modelPreparations = vi.spyOn(modelPresentation, "prepareOperatorModelPresentation");
    try {
      for (const count of [1, 4, 16, 65]) {
        const peers = Array.from({ length: count }, (_entry, i) => {
          const peer = createSessionRowEventPeer(profile, `fanout-${count}-${i}`, 1);
          peer.client.connect.caps = i % 2 ? ["ultrafast"] : [];
          connection.clients.add(peer.client);
          connection.sessionEventSubscribers.subscribe(peer.client.connId);
          return peer;
        });
        modelPreparations.mockClear();
        const stringify = JSON.stringify;
        let nestedKeyEncodings = 0;
        const encoding = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
          const value: unknown = args[0];
          if (
            Array.isArray(value) &&
            value.length === 3 &&
            typeof value[0] === "string" &&
            (value[1] === true || value[1] === "ultrafast")
          ) {
            nestedKeyEncodings++;
          }
          return stringify(...args);
        });
        try {
          connection.broadcastToConnIds(
            "sessions.changed",
            { sessionKey: key, agentId: "main" },
            new Set(peers.map((peer) => peer.client.connId)),
          );
        } finally {
          encoding.mockRestore();
        }
        expect.soft(modelPreparations).toHaveBeenCalledTimes(Math.min(count, 2));
        expect.soft(nestedKeyEncodings).toBe(0);
        for (const [i, peer] of peers.entries()) {
          expect(peer.send).toHaveBeenCalledOnce();
          const frame = peer.send.mock.lastCall![0];
          expect(frame).toBe(peers[i % 2]!.send.mock.lastCall![0]);
          const row = JSON.parse(frame).payload.session;
          expect(row).toMatchObject({
            key,
            sharingRole: "viewer",
            fastMode: i % 2 ? "ultrafast" : true,
          });
          expect(row).not.toHaveProperty("model");
          expect(row).not.toHaveProperty("modelProvider");
        }
      }
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});
