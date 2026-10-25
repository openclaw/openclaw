import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { dispatchProfile } from "./server/client-fixtures.test-support.js";
import { createInertGatewayTestSocket } from "./server/inert-socket.test-support.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { publishTranscriptFields } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it.each(["child and swarm links", "sharing role", "incognito"] as const)(
  "keeps one cached publication recipient-local for %s",
  async (restriction) => {
    const now = 1_000_000;
    using _ = vi.spyOn(Date, "now").mockReturnValue(now);
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      cfg.agents = { defaults: { model: { primary: "openai/gpt-5.4" } } };
      cfg.gateway!.roles!.definitions.admin = {
        sessions: { others: "write" },
        agents: "*",
        scopes: ["operator.admin"],
      };
      setRuntimeConfigSnapshot(cfg);
      const [allowed, restricted] = ["allowed", "restricted"].map((name) =>
        ensureProfileForEmail(`${name}@publication-authority.test`),
      );
      setUserProfileRole(allowed!.id, restriction === "incognito" ? "admin" : "view");
      setUserProfileRole(restricted!.id, restriction === "sharing role" ? "none" : "view");
      const query = {
        agentId: "main",
        key:
          restriction === "incognito"
            ? "agent:main:dashboard:incognito-publication"
            : "agent:main:publication",
      };
      const childKey = "agent:main:publication-child";
      await replaceSessionEntry(
        { agentId: query.agentId, sessionKey: query.key },
        {
          sessionId: "publication-session",
          updatedAt: now,
          label: "Publication authority",
          ...(restriction === "incognito" ? { incognito: true } : {}),
        },
      );
      if (restriction === "child and swarm links") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: childKey },
          {
            sessionId: "private-child",
            updatedAt: now,
            visibility: "draft",
            parentSessionKey: query.key,
            createdActor: { type: "human", source: "profile", id: allowed!.id },
          },
        );
        subagentRuns.set(
          "publication-child",
          createSubagentRunRecord({
            runId: "publication-child",
            childSessionKey: childKey,
            requesterSessionKey: query.key,
            requesterAgentId: "main",
            controllerSessionKey: query.key,
            swarmRequesterSessionKey: query.key,
            groupId: "publication-group",
            collect: true,
            createdAt: now - 100,
            startedAt: now - 100,
            endedAt: now - 50,
            completion: { required: false },
            delivery: { status: "not_required" },
            collectorCompletion: { status: "done" },
          }),
        );
      }
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "publication-authority",
        cfg,
      });
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      // Repeat each identity on a second socket so both visible projections exercise cache hits.
      const peers = [allowed!, restricted!, allowed!, restricted!].map((profile, index) => {
        const send = vi.fn();
        const client = {
          ...sharingPolicyClient({
            user: profile.id,
            ...(restriction === "incognito" && profile === allowed
              ? { scopes: ["operator.admin"] }
              : {}),
          }),
          connId: `publication-${index}`,
          usesSharedGatewayAuth: false,
          authenticatedUserProfile: dispatchProfile(profile.id, {
            displayName: profile.displayName,
            updatedAt: now,
          }),
          socket: createInertGatewayTestSocket(send),
        } satisfies GatewayWsClient;
        prepareGatewayRecipientProfile(client);
        connection.clients.add(client);
        return { send, client };
      });
      const detach = connection.attachSessionRowProjection(projection);
      try {
        await projection.ensureMaterialized();
        await withReadySessionRows(
          projection,
          () => [query],
          (read) => {
            const record = read.describe(query)!;
            publishTranscriptFields(
              record,
              { lastMessagePreview: "Private preview 🦞", fallbackModel: undefined },
              cfg,
              read.state.rowContext,
            );
            const presentations = vi.spyOn(projection, "present");
            const runViews = vi.spyOn(read.state.rowContext.subagentRuns, "atTime");
            const message = {
              role: "assistant",
              content: [{ type: "text", text: '"🦞"\n\\\ud800' }],
            };
            const stringify = JSON.stringify;
            let envelopes = 0;
            const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
              const value: unknown = args[0];
              if (
                isRecord(value) &&
                isRecord(value.payload) &&
                value.payload.sessionKey === query.key
              ) {
                envelopes++;
              }
              return stringify(...args);
            });
            const publish = () =>
              connection.broadcast(
                "session.message",
                {
                  sessionKey: query.key,
                  agentId: query.agentId,
                  message,
                  session: { key: query.key, sessionId: "publication-session" },
                },
                {
                  prepareSessionProjection: prepareSessionEventProjection(projection, read, {
                    ancestors: projection.ancestorRows(record, read),
                    encodeMessage: true,
                  }),
                },
              );
            publish();
            serialization.mockRestore();
            expect(envelopes).toBe(restriction === "child and swarm links" ? 2 : 1);
            for (const [index, { send }] of peers.entries()) {
              const visible = index % 2 === 0 || restriction === "child and swarm links";
              expect(send).toHaveBeenCalledTimes(visible ? 1 : 0);
              if (!visible) {
                continue;
              }
              const frame = JSON.parse(String(send.mock.calls[0]![0]));
              expect(frame.payload.message).toEqual(message);
              expect(frame.seq).toBe(1);
              expect(send.mock.calls[0]![1]).toEqual({ binary: false });
              const row = frame.payload.session;
              expect(row).toMatchObject({
                key: query.key,
                sessionId: "publication-session",
                lastMessagePreview: "Private preview 🦞",
                sharingRole: restriction === "incognito" ? "admin" : "viewer",
              });
              expect(row.childSessions).toEqual(
                restriction === "child and swarm links" && index % 2 === 0 ? [childKey] : undefined,
              );
              expect(row.swarm).toEqual(
                restriction === "child and swarm links"
                  ? {
                      groups: [
                        {
                          groupId: "publication-group",
                          createdAt: now - 100,
                          queued: 0,
                          running: 0,
                          done: 1,
                          failed: 0,
                          children:
                            index % 2 === 0 ? [{ sessionKey: childKey, status: "done" }] : [],
                        },
                      ],
                      otherActiveGroups: 0,
                    }
                  : undefined,
              );
            }
            expect(presentations).toHaveBeenCalledTimes(
              restriction === "child and swarm links" ? 2 : 1,
            );
            expect(runViews).toHaveBeenCalledTimes(restriction === "child and swarm links" ? 2 : 1);
            runViews.mockRestore();
            presentations.mockRestore();
            const capture = (phase: string) => {
              // Profile IDs are generated at admission; all other wire bytes are the golden contract.
              expect(
                peers.map(({ send }) =>
                  send.mock.lastCall
                    ? String(send.mock.lastCall[0])
                        .replaceAll(allowed!.id, "allowed-profile")
                        .replaceAll(restricted!.id, "restricted-profile")
                    : null,
                ),
              ).toMatchSnapshot(`${restriction}: ${phase}`);
            };
            capture("legacy");
            for (const caps of [
              ["session-row-deltas"],
              ["session-row-deltas", "session-event-field-refs"],
            ]) {
              for (const { client } of peers) {
                client.connect.caps = caps;
              }
              publish();
              capture(caps.join(" + "));
            }
          },
        );
      } finally {
        detach();
        await connection.mentionInbox.dispose();
        projection.dispose();
        subagentRuns.delete("publication-child");
      }
    });
  },
);
