/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
type Evidence = SessionMembersListEvidenceResult;
const baseRow = { sessionId: "current", kind: "direct", sharingRole: "owner" } as const;

async function mountSharingHeader(row: GatewaySessionRow, read: () => Promise<Evidence>) {
  const mounted = createMountedPanes([row], row.agentId, undefined, {
    "sessions.list": () => sessionsResult([row], 1),
  });
  const client = mounted.context.gateway.snapshot.client!;
  const originalRequest = client.request.bind(client);
  const sharingRead = vi.fn(read);
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
  const draw = () => {
    const workspace = createPaneHeaderWorkspaceFixture(pane.state);
    const selected = selectedChatSessionRow(pane.state);
    renderPaneHeaderInto(
      pane.renderPaneHeader(workspace, selected, false, undefined, false, null),
      container,
    );
  };
  const settle = async () => {
    await Promise.all(request.mock.results.map((result) => result.value));
    draw();
  };
  return { mounted, sharingRead, request, container, draw, settle };
}

it.each([
  { key: "agent:main:current", agentId: "main" },
  { key: "global", agentId: "research" },
])("updates the $key Public badge when another client changes sharing", async (target) => {
  const row: GatewaySessionRow = {
    ...target,
    ...baseRow,
    visibility: "draft",
  };
  const evidence = (token?: string): Evidence => ({
    sessionKey: row.key,
    members: [],
    identities: [],
    role: "owner",
    allowedVisibilities: ["shared", "draft"],
    ...(token ? { publicShare: { token, createdAt: 1 } } : {}),
  });
  let published = false;
  const { mounted, sharingRead, container, draw, settle } = await mountSharingHeader(
    row,
    async () => evidence(published ? "synthetic-public-locator" : undefined),
  );
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

  const staleRead = createDeferred<Evidence>();
  sharingRead.mockImplementationOnce(() => staleRead.promise);
  changed();
  published = false;
  changed(null);
  staleRead.resolve(evidence("synthetic-retired-locator"));
  await settle();
  expect(indicator()).toBeNull();
});

it("refreshes participation after profile and config changes and rejects an older reply", async () => {
  const row: GatewaySessionRow = {
    ...baseRow,
    key: "agent:main:permissions",
    agentId: "main",
    visibility: "read-only",
  };
  const evidence = (level: "read" | "send", fixed = false): Evidence => ({
    sessionKey: row.key,
    members: [],
    role: "owner",
    owner: { id: "owner", type: "human", label: "Owner" },
    identities: [{ id: "person", type: "human", label: "Pat" }],
    permissions: [{ identityId: "person", level, options: fixed ? [level] : ["read", "send"] }],
    allowedVisibilities: ["read-only"],
  });
  const { mounted, sharingRead, request, container, draw, settle } = await mountSharingHeader(
    row,
    async () => evidence("read"),
  );
  draw();
  await settle();
  container.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")!.click();
  await waitForSolid(() => expect(container.textContent).toContain("Can read"));
  sharingRead.mockResolvedValue(evidence("send", true));
  mounted.emitGatewayEvent("sessions.changed", { reason: "profile-identity" });
  draw();
  await settle();
  expect(container.querySelector('[data-value="member:person"]')?.textContent).toContain(
    "Can send",
  );
  expect(container.querySelector('[data-value="permission:person"]')).toBeNull();

  const old = createDeferred<Evidence>();
  sharingRead.mockImplementationOnce(() => old.promise);
  mounted.emitGatewayEvent("sessions.changed", { reason: "profile-identity" });
  draw();
  sharingRead.mockResolvedValue(evidence("read"));
  mounted.emitGatewayEvent("config.changed", { reason: "config-reload" });
  draw();
  old.resolve(evidence("send", true));
  await settle();
  expect(container.querySelector('[data-value="permission:person"]')?.textContent).toContain(
    "Can read",
  );
  expect(
    request.mock.calls.some(
      ([method]) => method === "session.members.add" || method === "session.members.remove",
    ),
  ).toBe(false);
});
