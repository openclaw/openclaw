/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { createPaneHeaderWorkspaceFixture } from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
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
    updatedAt: 1,
    visibility: "draft",
    sharingRole: "owner",
    label: "Design review",
  };
  const sharingResult: SessionMembersListEvidenceResult = {
    sessionKey: row.key,
    members: [],
    identities: [],
    role: "owner",
    allowedVisibilities: ["shared", "draft"],
  };
  const mounted = createMountedPanes([row], row.agentId, undefined, {
    "sessions.list": () => sessionsResult([row], 1),
  });
  const client = mounted.context.gateway.snapshot.client!;
  const originalRequest = client.request.bind(client);
  let published = false;
  const sharingRead = vi.fn(async () => ({
    ...sharingResult,
    ...(published ? { publicShare: { token: "synthetic-public-locator", createdAt: 1 } } : {}),
  }));
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
    render(
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
  draw();
  await Promise.all(request.mock.results.map((result) => result.value));
  draw();
  expect(sharingRead).toHaveBeenCalledOnce();
  expect(container.querySelector(".chat-pane__public-share-indicator")).toBeNull();

  published = true;
  mounted.emitGatewayEvent("sessions.changed", {
    reason: "sharing",
    sessionKey: row.key === "global" ? "global" : "agent:unrelated:current",
    agentId: "unrelated",
  });
  draw();
  expect(sharingRead).toHaveBeenCalledOnce();
  expect(container.querySelector(".chat-pane__public-share-indicator")).toBeNull();
  mounted.emitGatewayEvent("sessions.changed", {
    reason: "sharing",
    sessionKey: row.key,
    agentId: row.agentId,
  });
  draw();
  await Promise.all(request.mock.results.map((result) => result.value));
  draw();
  expect(
    container.querySelector(".chat-pane__public-share-indicator")?.textContent ?? "",
  ).toContain("Public");

  const staleRead = createDeferred<SessionMembersListEvidenceResult>();
  sharingRead.mockImplementationOnce(() => staleRead.promise);
  mounted.emitGatewayEvent("sessions.changed", {
    reason: "sharing",
    sessionKey: row.key,
    agentId: row.agentId,
  });
  draw();
  published = false;
  mounted.emitGatewayEvent("sessions.changed", { reason: "sharing" });
  draw();
  staleRead.resolve({
    ...sharingResult,
    publicShare: { token: "synthetic-retired-locator", createdAt: 1 },
  });
  await Promise.all(request.mock.results.map((result) => result.value));
  draw();
  expect(container.querySelector(".chat-pane__public-share-indicator")).toBeNull();
});
