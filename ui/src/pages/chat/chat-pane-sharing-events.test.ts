/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { createPaneHeaderWorkspaceFixture } from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

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
