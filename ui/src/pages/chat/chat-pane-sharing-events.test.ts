/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  createInitializationContext,
  createPaneHeaderWorkspaceFixture,
  createRenderTestChatPane,
} from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { RealtimeTalkSession } from "./talk/session.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(["provider-pause", "read-only", "revoked"] as const)(
  "retires Talk after %s and prevents it from starting again",
  async (restriction) => {
    const row: GatewaySessionRow = {
      key: "agent:main:provider-pause",
      agentId: "main",
      sessionId: "provider-pause",
      kind: "direct",
      updatedAt: 1,
    };
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([row]);
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(row.key);
    await refreshPane(pane);
    const client = pane.state.client;
    if (!client) {
      throw new Error("Expected connected pane");
    }
    const talk = new RealtimeTalkSession(client, row.key);
    const stop = vi.spyOn(talk, "stop").mockResolvedValue(undefined);
    pane.state.realtimeTalk.update({ realtimeTalkSession: talk });
    pane.state.realtimeTalk.update({ realtimeTalkActive: true });
    if (restriction === "provider-pause") {
      emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        agentId: "main",
        session: {
          ...row,
          updatedAt: 2,
          providerReview: {
            id: "provider-review",
            runId: "stopped-run",
            canContinue: false,
          },
        },
      });
    } else {
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        sessionAccess: [
          {
            agentId: "main",
            sessionKey: row.key,
            sessionId: row.sessionId!,
            access: restriction,
          },
        ],
      });
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pane.state.realtimeTalk.snapshot.realtimeTalkSession).toBeNull();
    expect(pane.state.realtimeTalk.snapshot.realtimeTalkActive).toBe(false);
    await pane.state.toggleRealtimeTalk();
    expect(pane.state.realtimeTalk.snapshot.realtimeTalkSession).toBeNull();
  },
);

it.each(["shared", "suggest"] as const)(
  "revokes the existing and late-mounted %s composer from an explicit access event",
  (visibility) => {
    const row: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: "shared-session",
      kind: "global",
      visibility,
      sharingRole: "viewer",
    };
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.start();
    current().request.mockResolvedValue({ profile: { id: "viewer", emails: [] } });
    Object.defineProperty(current(), "recoveryScopeReady", { value: true });
    const hello = sessionMutationGatewayHello(["operator.write"]);
    hello.features = {
      methods: [
        ...(hello.features?.methods ?? []),
        "session.suggestions.add",
        "session.suggestions.list",
      ],
    };
    current().testOptions.onHello?.(hello);
    const client = expectDefined(gateway.snapshot.client, "connected client");
    const sessions = createTestSessionCapability(gateway);
    const context = { ...createInitializationContext(client), gateway, sessions };
    onTestFinished(() => {
      sessions.dispose();
      gateway.stop();
    });
    const mount = () => {
      const pane = createRenderTestChatPane();
      const state = pane.initialize(context);
      Object.assign(state, {
        client,
        connected: true,
        hello,
        assistantAgentId: "main",
        sessionKey: row.key,
        currentSessionId: row.sessionId,
        sessionsResult: sessionsResult([row], 1),
        sessionsResultAgentId: "main",
      });
      pane.presence.update({
        presence: [
          { ts: 1, user: { id: "owner" } },
          { ts: 1, user: { id: "viewer" } },
        ],
      });
      setChatHistoryLoad(state, {
        phase: "committed",
        sessions,
        client,
        connectionEpoch: state.connectionEpoch,
        sessionKey: row.key,
        requestAgentId: "main",
        sessionId: row.sessionId,
        sessionInfo: row,
      });
      return () => {
        pane.render();
        return expectDefined(pane.chatProps, "composer props");
      };
    };
    const read = mount();
    expect(read().canCompose).toBe(true);
    expect(read().canSend).toBe(true);
    expect(read().suggestionComposer).toBe(visibility === "suggest");
    const publish = (
      agentId = "main",
      sessionId = row.sessionId,
      access: "revoked" | "read-only" | "read-write" = "revoked",
    ) =>
      current().testOptions.onEvent?.(
        createGatewayEvent("session.access.changed", {
          agentId,
          sessionKey: row.key,
          sessionId,
          access,
        }),
      );
    publish("research");
    publish("main", "retired-session");
    expect(read().canSend).toBe(true);

    publish("main", row.sessionId, "read-only");
    expect(read().canCompose).toBe(visibility === "suggest");
    expect(read().canSend).toBe(visibility === "suggest");
    publish();

    expect(read().canCompose).toBe(false);
    expect(read().canSend).toBe(false);
    const readLatePane = mount();
    expect(readLatePane().canCompose).toBe(false);
    expect(readLatePane().canSend).toBe(false);
    // Restoration for an old incarnation cannot clear the current restriction.
    publish("main", "retired-session", "read-write");
    expect(read().canSend).toBe(false);
    publish("main", row.sessionId, "read-write");
    expect(read().canSend).toBe(true);
    expect(readLatePane().canSend).toBe(true);
    // The positive event is not a grant over either row or global write limits.
    row.visibility = "draft";
    publish("main", row.sessionId, "read-write");
    expect(read().canSend).toBe(false);
    row.visibility = visibility;
    hello.auth = { role: "operator", scopes: [] };
    publish("main", row.sessionId, "read-write");
    expect(read().canSend).toBe(false);
  },
);

it.each([
  { key: "agent:main:current", agentId: "main" },
  { key: "global", agentId: "research" },
])("updates the $key Public badge when another client changes sharing", async (target) => {
  const row: GatewaySessionRow = {
    ...target,
    sessionId: "session-current",
    kind: "direct",
    visibility: "draft",
    sharingRole: "owner",
  };
  const evidence = (token?: string): SessionMembersListEvidenceResult => ({
    sessionKey: row.key,
    members: [],
    identities: [],
    role: "owner",
    allowedVisibilities: ["shared", "draft"],
    ...(token ? { publicShare: { token, createdAt: 1 } } : {}),
  });
  const mounted = createMountedPanes([row], row.agentId, undefined, {
    "sessions.list": () => sessionsResult([row], 1),
  });
  const client = mounted.context.gateway.snapshot.client!;
  const originalRequest = client.request.bind(client);
  let published = false;
  const sharingRead = vi.fn(async () =>
    evidence(published ? "synthetic-public-locator" : undefined),
  );
  const request = vi
    .spyOn(client, "request")
    .mockImplementation(async (method, params, options) =>
      method === "session.members.listEvidence"
        ? sharingRead()
        : originalRequest(method, params, options),
    );
  const hello = mounted.context.gateway.snapshot.hello!;
  hello.features = {
    ...hello.features,
    methods: [
      ...(hello.features?.methods ?? []),
      "session.visibility.set",
      "session.members.listEvidence",
    ],
  };
  await mounted.sessions.refresh({ agentId: row.agentId, force: true });
  const pane = mounted.mount(row.key);
  await refreshPane(pane);
  const container = document.body.appendChild(document.createElement("div"));
  const draw = () =>
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(pane.state),
        selectedChatSessionRow(pane.state),
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
  const settle = async () => {
    await Promise.all(request.mock.results.map((result) => result.value));
    draw();
  };
  const indicator = () =>
    container.querySelector(".chat-pane__sharing-trigger[data-public='true']");
  const changed = (key: string | null = row.key, agentId = row.agentId) => {
    mounted.emitGatewayEvent("sessions.changed", {
      reason: "sharing",
      ...(key ? { sessionKey: key, agentId } : {}),
    });
    draw();
  };
  draw();
  await settle();
  expect(sharingRead).toHaveBeenCalledOnce();
  expect(indicator()).toBeNull();

  published = true;
  changed(row.key === "global" ? "global" : "agent:unrelated:current", "unrelated");
  expect(sharingRead).toHaveBeenCalledOnce();
  expect(indicator()).toBeNull();
  changed();
  await settle();
  expect(indicator()?.textContent ?? "").toContain("Public");

  const staleRead = createDeferred<SessionMembersListEvidenceResult>();
  sharingRead.mockImplementationOnce(() => staleRead.promise);
  changed();
  published = false;
  changed(null);
  staleRead.resolve(evidence("synthetic-retired-locator"));
  await settle();
  expect(indicator()).toBeNull();
});
