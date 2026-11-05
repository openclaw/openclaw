import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as modelPresentation from "./operator-model-presentation.js";
import { createSessionLifecyclePublisher } from "./server-chat-lifecycle-publication.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-lifecycle-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
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

it.each(["direct", "lifecycle", "agent"])("shares %s envelopes", async (producer) => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    cfg.agents = { entries: { main: {} } };
    setRuntimeConfigSnapshot(cfg);
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
    const publish = async (ids: string[]) => {
      if (producer === "lifecycle") {
        await createLifecycleEventBroadcastHandler({
          broadcastToConnIds: connection.broadcastToConnIds,
          sessionEventSubscribers: { getAll: () => new Set(ids) },
          getSessionRowProjection: () => projection,
        })({ sessionKey: key, agentId: "main", reason: "rename" });
      } else if (producer === "agent") {
        createSessionLifecyclePublisher({
          broadcastToConnIds: (event, payload, _ids, options) =>
            connection.broadcastToConnIds(event, payload, new Set(ids), options),
          sessionEventSubscribers: connection.sessionEventSubscribers,
          getSessionRowProjection: () => projection,
          persistGatewaySessionLifecycleEventForEvent: async () => {},
          loadGatewaySessionLifecycleSnapshotForEvent: (_key, options) => {
            const read = options!.sessionRows!;
            const record = read.describe({ key, agentId: "main" })!;
            return { row: read.present(record) };
          },
        }).publish({
          phase: "model",
          sessionKey: key,
          agentId: "main",
          clientRunId: "run",
          event: { runId: "run", stream: "lifecycle", seq: 1, ts: Date.now(), data: {} },
          runContext: undefined,
        });
        await drainSessionEventPublications(projection);
      } else {
        connection.broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey: key,
            agentId: "main",
            reason: "rename",
            ["__proto__"]: { fixture: "own-data-property" },
          },
          new Set(ids),
          {
            prepareSessionProjection: prepareSessionEventProjection(projection, undefined, {
              ancestors: [],
              reuseEnvelope: true,
            }),
          },
        );
      }
    };
    const decodeLast = (peer: (typeof peers)[number]) => {
      const frame = JSON.parse(peer.send.mock.lastCall![0]) as EventFrame;
      let decoded: EventFrame | undefined;
      peer.decoder.dispatch(frame, (event) => {
        decoded = event;
      });
      return decoded?.payload;
    };
    const prime = async (selected: typeof peers, label: string) => {
      const previousSends = selected.map((peer) => peer.send.mock.calls.length);
      await publish(selected.map((peer) => peer.client.connId));
      for (const [index, peer] of selected.entries()) {
        expect(peer.send).toHaveBeenCalledTimes(previousSends[index]! + 1);
        expect(decodeLast(peer)).toMatchObject({
          session: { label },
        });
      }
    };
    try {
      await prime(
        peers.filter((peer) =>
          peer.capability === "legacy" ? peer.copy === 0 : peer.baseline === "stale",
        ),
        "Before",
      );
      write("After");
      await projection.ensureMaterialized();
      await prime(
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
      const envelopeTuples = new Set<unknown>();
      let envelopeMaxFields = 0;
      let filteredEnvelopes = 0;
      let fieldNameInsertions = 0;
      let stagedFieldIndexTuples = 0;
      const MapConstructor = globalThis.Map;
      globalThis.Map = new Proxy(MapConstructor, {
        construct(target, args) {
          const entries: unknown = args[0];
          if (
            Array.isArray(entries) &&
            entries.some(
              (entry: unknown) =>
                Array.isArray(entry) && entry[0] === "sharingRole" && typeof entry[1] === "number",
            )
          ) {
            stagedFieldIndexTuples += entries.length;
          }
          return Reflect.construct(target, args);
        },
      });
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
      const fromEntries = Object.fromEntries;
      const copying = vi.spyOn(Object, "fromEntries").mockImplementation((entries) => {
        const result = fromEntries(entries);
        if (result.sessionKey === key && isRecord(result.session) && Array.isArray(entries)) {
          filteredEnvelopes++;
          envelopeMaxFields = Math.max(envelopeMaxFields, entries.length);
          for (const entry of entries) {
            envelopeTuples.add(entry);
          }
        }
        return result;
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
      let ancestorFieldEncodings = 0;
      const encoding = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
        const value: unknown = args[0];
        if (
          isRecord(value) &&
          Object.keys(value).length === 1 &&
          (Object.hasOwn(value, "ancestorSessions") || Object.hasOwn(value, "ancestorSessionRefs"))
        ) {
          ancestorFieldEncodings++;
        }
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
        await publish(peers.map((peer) => peer.client.connId));
      } finally {
        globalThis.Map = MapConstructor;
        encoding.mockRestore();
        enumerating.mockRestore();
        adding.mockRestore();
        copying.mockRestore();
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
        if (producer === "direct") {
          expect(Object.getOwnPropertyDescriptor(payload, "__proto__")?.value).toEqual({
            fixture: "own-data-property",
          });
        }
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
      await publish(peers.map((peer) => peer.client.connId));
      for (const [index, peer] of peers.entries()) {
        const visible = peer.profile === owner;
        expect(peer.send).toHaveBeenCalledTimes(beforeRevocation[index]! + Number(visible));
        if (visible) {
          expect(decodeLast(peer)).toMatchObject({
            session: { label: "After", sharingRole: "owner" },
          });
        }
      }
      // Field order needs only names, never a temporary tuple for every row value.
      expect([...fieldEnumerations.values()]).toEqual([]);
      // Referenced fields must not allocate entry tuples just to discard them.
      expect(envelopeEnumerations).toBe(0);
      // Interleaved histories and audiences share only synchronous copy scratch space.
      expect(envelopeTuples.size).toBe(envelopeMaxFields);
      // A producer-owned envelope is filtered once per authority, even with divergent baselines.
      expect(filteredEnvelopes).toBe(2);
      // Field names are indexed once per audience, not inserted into a Set per history.
      expect(fieldNameInsertions).toBe(0);
      // Index construction must not stage a tuple for every field before inserting it.
      expect(stagedFieldIndexTuples).toBe(0);
      // Row changes retain connection keys; only four unprimed legacy sockets need encoding.
      expect(sharingKeyEncodings).toBe(4);
      // Four authority/baseline groups share row planning across both delta capabilities.
      expect(rowEncodings).toBeLessThanOrEqual(16);
      // Two wire capabilities per group, plus one legacy envelope per authority.
      expect(envelopeEncodings).toBeLessThanOrEqual(10);
      // Empty ancestor fields are constant across divergent connection histories.
      expect(ancestorFieldEncodings).toBe(0);
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

it("shares model presentation and full-row encodings across audience delivery histories", async () => {
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
    let detach = connection.attachSessionRowProjection(projection);
    using modelPreparations = vi.spyOn(modelPresentation, "prepareOperatorModelPresentation");
    try {
      for (const [count, deltas] of [
        [1, false],
        [4, false],
        [16, false],
        [65, false],
        [65, true],
      ] as const) {
        const peers = Array.from({ length: count }, (_entry, i) => {
          const peer = createSessionRowEventPeer(profile, `fanout-${count}-${i}`, 1);
          peer.client.connect.caps = [
            ...(i % 2 ? ["ultrafast"] : []),
            ...(deltas ? ["session-row-deltas"] : []),
          ];
          connection.clients.add(peer.client);
          connection.sessionEventSubscribers.subscribe(peer.client.connId);
          return peer;
        });
        if (deltas) {
          for (const [index, peer] of peers.entries()) {
            for (let prior = 0; prior <= index % 4; prior++) {
              connection.broadcastToConnIds(
                "sessions.changed",
                { sessionKey: key, agentId: "main" },
                new Set([peer.client.connId]),
              );
            }
            peer.send.mockClear();
          }
          detach();
          detach = connection.attachSessionRowProjection(projection);
        }
        modelPreparations.mockClear();
        const stringify = JSON.stringify;
        let nestedKeyEncodings = 0;
        let fullRowTraversals = 0;
        const encoding = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
          const value: unknown = args[0];
          if (isRecord(value) && isRecord(value.full) && value.full.key === key) {
            fullRowTraversals++;
          }
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
        // History-specific wrappers must reuse the immutable row encoding.
        expect.soft(fullRowTraversals).toBe(0);
        for (const [i, peer] of peers.entries()) {
          expect(peer.send).toHaveBeenCalledOnce();
          const frame = peer.send.mock.lastCall![0];
          if (!deltas) {
            expect(frame).toBe(peers[i % 2]!.send.mock.lastCall![0]);
          }
          const session = JSON.parse(frame).payload.session;
          if (deltas) {
            expect(session.version).toBe(2 + (i % 4));
          }
          const row = deltas ? session.full : session;
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
