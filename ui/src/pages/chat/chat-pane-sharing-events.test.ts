/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChatPaneHeaderPeople } from "./chat-pane-header-people.ts";
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

it.each([
  ["owner", 0],
  ["viewer", 1],
] as const)(
  "rereads history after a keyless sharing change only when %s access can be lost",
  async (sharingRole, rereads) => {
    const row: GatewaySessionRow = {
      ...baseRow,
      key: "agent:main:shared",
      agentId: "main",
      sharingRole,
    };
    const { mounted, request, draw, settle } = await mountSharingHeader(row, async () => ({
      sessionKey: row.key,
      members: [],
      identities: [],
      role: sharingRole,
      allowedVisibilities: [],
    }));
    await settle();
    const historyReads = () =>
      request.mock.calls.filter(([method]) =>
        ["chat.history", "chat.startup", "sessions.messages.subscribe"].includes(method),
      ).length;
    const before = historyReads();
    mounted.emitGatewayEvent("sessions.changed", { reason: "sharing" });
    draw();
    await settle();
    await vi.waitFor(() => expect(historyReads() - before).toBe(rereads));
  },
);

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
  await vi.dynamicImportSettled();
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

it("refreshes header people for two invited members who never sent and removes a revoked member", async () => {
  const owner = {
    type: "human",
    id: "owner",
    identity: { type: "profile", id: "owner" },
    label: "Owner",
  } as const;
  const row: GatewaySessionRow = {
    ...baseRow,
    key: "agent:main:quiet-members",
    agentId: "main",
    owner: { actor: owner },
    createdActor: owner,
    participantCount: 0,
  };
  let members = ["quiet-one", "quiet-two"].map((identityId) => ({ identityId, addedAt: 1 }));
  const identities = members.map(({ identityId: id }) => ({
    type: "human" as const,
    id,
    identity: { type: "profile" as const, id },
    label: id,
  }));
  const { mounted, container, draw, settle } = await mountSharingHeader(row, async () => ({
    sessionKey: row.key,
    role: "owner",
    allowedVisibilities: [],
    members,
    identities,
  }));
  await settle();
  const ids = () => {
    const facepile = container.querySelector("openclaw-viewer-facepile.chat-pane__participants") as
      | (HTMLElement & { staticParticipants?: { identity: { id: string } }[] })
      | null;
    return facepile?.staticParticipants?.map(({ identity }) => identity.id) ?? [];
  };
  expect(ids()).toEqual(["quiet-one", "quiet-two"]);
  members = members.slice(0, 1);
  mounted.emitGatewayEvent("sessions.changed", {
    reason: "sharing",
    sessionKey: row.key,
    agentId: row.agentId,
  });
  draw();
  await settle();
  expect(ids()).toEqual(["quiet-one"]);
});

it("shows a quiet member only once across static header People and live presence", () => {
  const owner = { type: "human", id: "owner", identity: { type: "profile", id: "owner" } } as const;
  const member = {
    type: "human",
    id: "quiet",
    identity: { type: "profile", id: "quiet" },
    label: "Quiet Person",
  } as const;
  const sessionKey = "agent:main:quiet-header";
  const session = { ...baseRow, key: sessionKey, owner: { actor: owner }, participantCount: 0 };
  const sharing: Evidence = {
    sessionKey,
    owner,
    members: [{ identityId: member.id, addedAt: 1 }],
    identities: [owner, member],
    role: "owner",
    allowedVisibilities: [],
  };
  const presence = {
    presence: [
      {
        ts: 1,
        user: { id: member.id, identity: member.identity, name: member.label },
        watchedSessions: [sessionKey],
      },
    ],
  };
  const input = {
    session,
    sharing,
    presence,
    sessionKey,
    ownerCount: 1,
    catalog: false,
    detailsControl: undefined,
    selfUser: null,
    instanceId: undefined,
    mentionableUsers: undefined,
  };
  const projection = new ChatPaneHeaderPeople();
  expect(projection.read(input).viewers).toEqual([]);
  expect(projection.read(input).mobilePeople?.viewers).toHaveLength(1);
  expect(projection.read(input).mobilePeople?.participants).toHaveLength(1);
  expect(projection.read({ ...input, detailsControl: {} }).viewers).toHaveLength(1);
});
