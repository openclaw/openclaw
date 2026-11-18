import { createServer, type IncomingMessage } from "node:http";
import http from "node:http";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.test-support.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { startGatewayServerCore } from "./server-start.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
type Mode =
  | "enforcement-off"
  | "enforcement-on-permissive-default"
  | "enforcement-on-denying-default";

const ROLES: Record<string, GatewayOperatorRoleDefinition> = {
  "session-guest": {
    sessions: { others: "invited" },
    agents: ["main"],
    scopes: ["operator.sessions.read", "operator.sessions.write"],
    sandbox: "required",
  },
  // Same membership shape without the sandbox requirement, to separate the write rule.
  "session-guest-unsandboxed": {
    sessions: { others: "invited" },
    agents: ["main"],
    scopes: ["operator.sessions.read", "operator.sessions.write"],
  },
  "session-writer": {
    sessions: { others: "invited" },
    agents: ["main"],
    scopes: ["operator.read", "operator.write"],
  },
  "session-writer-sandboxed": {
    sessions: { others: "invited" },
    agents: ["main"],
    scopes: ["operator.read", "operator.write"],
    sandbox: "required",
  },
  "session-approver": {
    sessions: { others: "invited" },
    agents: ["main"],
    scopes: ["operator.read", "operator.write", "operator.approvals"],
  },
  staff: {
    sessions: { others: "write" },
    agents: "*",
    scopes: ["operator.read", "operator.write"],
  },
  blocked: { sessions: { others: "none" }, agents: [], scopes: [] },
};

async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function runScenario(mode: Mode, signal: AbortSignal) {
  const state = await createOpenClawTestState(kernelGatewayTestStateOptions(`oid-invite-${mode}`));
  const clients: Client[] = [];
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  // A user turn ending in RUN_EXEC asks for one exec call; everything else gets a text reply.
  const provider = createServer((request, response) => {
    void readRequestText(request).then((body) => {
      const input = (JSON.parse(body) as { input?: Array<{ type?: string }> }).input ?? [];
      const lastOutput = input.findLastIndex((item) => item.type === "function_call_output");
      const pending = JSON.stringify(input.slice(lastOutput + 1));
      if (!body.includes("Generate a concise session title") && pending.includes("RUN_EXEC")) {
        writeToolCall(response, "exec", { command: "printf approval-proof" });
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "Acknowledged.",
        messageId: "invite-reply",
        responseId: "invite-response",
      });
    });
  });
  const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "oid-invite");
  const port = await getFreePort();
  const token = "oid-invite-token";
  const members = {
    guest: { origin: "http://guest.member.test", account: "acct-guest", role: "session-guest" },
    guestUnsandboxed: {
      origin: "http://guest2.member.test",
      account: "acct-guest2",
      role: "session-guest-unsandboxed",
    },
    writer: { origin: "http://writer.member.test", account: "acct-writer", role: "session-writer" },
    approver: {
      origin: "http://approver.member.test",
      account: "acct-approver",
      role: "session-approver",
    },
    writerSandboxed: {
      origin: "http://writer2.member.test",
      account: "acct-writer2",
      role: "session-writer-sandboxed",
    },
  } as const;
  const peers = new Map<string, string>();
  type GatewayEvent = { event?: string; payload?: unknown };
  const events = new Map<string, GatewayEvent[]>();
  for (const member of Object.values(members)) {
    peers.set(member.origin, formatIrohEndpointKey((await generateEd25519Signer()).publicKey));
    events.set(member.origin, []);
  }
  // oxlint-disable-next-line typescript/unbound-method -- The observer supplies the original server receiver.
  const emit = http.Server.prototype.emit;
  const intercepted = vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
    this: http.Server,
    event,
    ...args
  ) {
    if (event === "upgrade" || event === "request") {
      const req = args[0] as IncomingMessage;
      const peerKey = req.headers.origin ? peers.get(req.headers.origin) : undefined;
      if (peerKey) {
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey,
          clientIp: "fd7a:115c:a1e0::1",
        });
      }
    }
    return emit.call(this, event, ...args);
  });
  try {
    await state.writeConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
        ownership: "explicit",
        entries: { main: {}, other: {} },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      tools: { profile: "minimal", alsoAllow: ["exec"], exec: { host: "gateway" } },
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        openclawId: { enabled: true },
        roles: {
          definitions: ROLES,
          ...(mode === "enforcement-on-permissive-default"
            ? { default: "staff" }
            : mode === "enforcement-on-denying-default"
              ? { default: "blocked" }
              : {}),
        },
        controlUi: {
          allowedOrigins: [
            `http://127.0.0.1:${port}`,
            ...Object.values(members).map((m) => m.origin),
          ],
        },
      },
    });
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    for (const member of Object.values(members)) {
      expect(
        await claw.authority.submit(
          await claw.sign({
            op: "add",
            account_id: member.account,
            role: member.role,
            peer_keys: [peers.get(member.origin)!],
            invite_id: null,
          }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
    }
    // A saved binding makes Gateway start publish the token-binding owner without a live tunnel.
    await claw.authority.bindToken(
      "seed-member-browser",
      "operator",
      peers.get(members.guest.origin)!,
    );
    server = await startGatewayServerCore(port, { bind: "loopback", controlUiEnabled: false });
    const ownerEvents: GatewayEvent[] = [];
    // Human mentions require a signed-in Control UI chat connection.
    const owner = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      origin: `http://127.0.0.1:${port}`,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      platform: "web",
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS, GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
      onEvent: (event) => ownerEvents.push(event),
      signal,
    });
    clients.push(owner);
    await expect
      .poll(() => getRuntimeConfig().gateway?.roles?.definitions.operator)
      .toEqual(MEMBER_ROLE_PRESETS.operator);
    expect(getRuntimeConfig().gateway?.roles?.definitions["session-guest"]).toEqual(
      ROLES["session-guest"],
    );
    expect(getRuntimeConfig().gateway?.roles?.default).toBe(
      mode === "enforcement-on-permissive-default"
        ? "staff"
        : mode === "enforcement-on-denying-default"
          ? "blocked"
          : undefined,
    );
    const connectMember = async (origin: string) => {
      let client: Client | undefined;
      // The OpenClaw ID service publishes its token-binding owner after Gateway startup.
      for (let attempt = 0; !client; attempt += 1) {
        try {
          client = await connectMember_(origin);
        } catch (error) {
          if (attempt > 40 || !String(error).includes("bindings are unavailable")) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      clients.push(client);
      const self = await client.request<{ profile: { id: string } }>("users.self", {});
      return { client, profileId: self.profile.id };
    };
    const connectMember_ = async (origin: string) =>
      connectGatewayClient({
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS, GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        onEvent: (event) => events.get(origin)?.push(event),
        url: `ws://127.0.0.1:${port}`,
        origin,
        timeoutMs: 6000,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        scopes: [
          "operator.read",
          "operator.write",
          "operator.sessions.read",
          "operator.sessions.write",
          "operator.approvals",
        ],
        signal,
      });
    const guest = await connectMember(members.guest.origin);
    const guest2 = await connectMember(members.guestUnsandboxed.origin);
    const writer = await connectMember(members.writer.origin);
    const writer2 = await connectMember(members.writerSandboxed.origin);
    const approver = await connectMember(members.approver.origin);

    const create = async (agentId: string) =>
      (
        await owner.request<{ key: string }>("sessions.create", {
          agentId,
          visibility: "shared",
        })
      ).key;
    const invitedKey = await create("main");
    const otherKey = await create("main");
    const otherAgentKey = await create("other");

    const listed = async (client: Client) =>
      settle(
        client
          .request<{ sessions: { key: string }[] }>("sessions.list", {})
          .then((r) => r.sessions.map((s) => s.key)),
      );
    const visible = async (client: Client) => {
      const keys = await listed(client);
      return keys.ok
        ? {
            invited: keys.value.includes(invitedKey),
            other: keys.value.includes(otherKey),
            otherAgent: keys.value.includes(otherAgentKey),
          }
        : keys;
    };
    const report: Record<string, unknown> = { mode };
    // Check 3: permission-mode changes on an idle invited owner session (no run yet).
    const permKey = await create("main");
    for (const profileId of [guest2.profileId, writer.profileId, writer2.profileId]) {
      await owner.request("session.members.add", { sessionKey: permKey, identityId: profileId });
    }
    const mode_ = () => loadSessionEntry({ agentId: "main", sessionKey: permKey })?.permissionMode;
    const patch = (client: Client, permissionMode: string) =>
      settle(client.request("sessions.patch", { key: permKey, permissionMode })).then((r) =>
        r.ok ? `accepted (now ${String(mode_())})` : r.error,
      );
    report.check3InitialMode = mode_() ?? null;
    report.check3OwnerSetsGuarded = await patch(owner, "guarded");
    report.check3WriterGuardedToWorkspace = await patch(writer.client, "workspace");
    report.check3OwnerSetsGuardedAgain = await patch(owner, "guarded");
    report.check3WriterToFull = await patch(writer.client, "full");
    report.check3OwnerSetsReadOnly = await patch(owner, "read-only");
    report.check3WriterLoosensReadOnly = await patch(writer.client, "workspace");
    report.check3OwnerSetsReadOnlyAgain = await patch(owner, "read-only");
    report.check3GuestLoosensReadOnly = await patch(guest2.client, "workspace");
    report.check3SandboxedWriterLoosensReadOnly = await patch(writer2.client, "workspace");
    report.check3FinalMode = mode_() ?? null;
    const mentionable = await settle(
      owner.request<{ users: { profileId: string }[] }>("users.mentionable", {
        sessionKey: invitedKey,
      }),
    );
    report.mentionable = mentionable.ok
      ? {
          guest: mentionable.value.users.some((u) => u.profileId === guest.profileId),
          guest2: mentionable.value.users.some((u) => u.profileId === guest2.profileId),
          writer: mentionable.value.users.some((u) => u.profileId === writer.profileId),
          writer2: mentionable.value.users.some((u) => u.profileId === writer2.profileId),
        }
      : mentionable;
    const message = "@Guest @Guest2 @Writer @Writer2 please join.";
    const send = await settle(
      owner.request("chat.send", {
        sessionKey: invitedKey,
        message,
        idempotencyKey: `invite-${mode}`,
        mentions: [
          { profileId: guest.profileId, start: 0, end: 6 },
          { profileId: guest2.profileId, start: 7, end: 14 },
          { profileId: writer.profileId, start: 15, end: 22 },
          { profileId: writer2.profileId, start: 23, end: 31 },
        ],
      }),
    );
    report.mentionSend = send.ok ? "accepted" : send;
    const members_ = await settle(
      owner.request<{ members: { identityId: string }[] }>("session.members.list", {
        sessionKey: invitedKey,
      }),
    );
    report.membersAfterMention = members_.ok
      ? {
          guest: members_.value.members?.some((m) => m.identityId === guest.profileId),
          guest2: members_.value.members?.some((m) => m.identityId === guest2.profileId),
          writer: members_.value.members?.some((m) => m.identityId === writer.profileId),
          writer2: members_.value.members?.some((m) => m.identityId === writer2.profileId),
        }
      : members_;
    report.visibleAfterMention = {
      guest: await visible(guest.client),
      guest2: await visible(guest2.client),
      writer: await visible(writer.client),
      writer2: await visible(writer2.client),
    };
    report.inboxAfterMention = {
      guest: await settle(
        guest.client.request<{ items: unknown[] }>("mentions.list", {}).then((r) => r.items.length),
      ),
      writer: await settle(
        writer.client
          .request<{ items: unknown[] }>("mentions.list", {})
          .then((r) => r.items.length),
      ),
    };
    report.guestHistoryAfterMention = (
      await settle(guest.client.request("chat.history", { sessionKey: invitedKey, limit: 5 }))
    ).ok;

    // Explicit membership isolates checks 1 and 2 from the mention-picker result.
    for (const profileId of [
      guest.profileId,
      guest2.profileId,
      writer.profileId,
      writer2.profileId,
    ]) {
      await settle(
        owner.request("session.members.add", { sessionKey: invitedKey, identityId: profileId }),
      );
    }
    report.explicitAddOtherAgent = await settle(
      owner.request("session.members.add", {
        sessionKey: otherAgentKey,
        agentId: "other",
        identityId: writer.profileId,
      }),
    );
    report.visibleAfterExplicitAdd = {
      guest: await visible(guest.client),
      guest2: await visible(guest2.client),
      writer: await visible(writer.client),
    };
    report.guestHistory = (
      await settle(guest.client.request("chat.history", { sessionKey: invitedKey, limit: 5 }))
    ).ok;
    const turn = (client: Client, sessionKey: string, id: string, agentId?: string) =>
      settle(
        client.request("chat.send", {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          message: "hello from a member",
          idempotencyKey: `${id}-${mode}`,
        }),
      ).then((r) => (r.ok ? "accepted" : r.error));
    report.check1GuestSandboxedTurn = await turn(guest.client, invitedKey, "guest-turn");
    report.check1GuestUnsandboxedTurn = await turn(guest2.client, invitedKey, "guest2-turn");
    report.check2WriterInvitedTurn = await turn(writer.client, invitedKey, "writer-turn");
    report.check2SandboxedWriterInvitedTurn = await turn(
      writer2.client,
      invitedKey,
      "writer2-turn",
    );
    report.check2WriterOtherSessionTurn = await turn(writer.client, otherKey, "writer-other");
    report.check2WriterOtherAgentTurn = await turn(
      writer.client,
      otherAgentKey,
      "writer-other-agent",
      "other",
    );

    // Check 4: approvals for exec raised in a guarded invited session.
    const approvalKey = await create("main");
    await owner.request("sessions.patch", { key: approvalKey, permissionMode: "guarded" });
    await owner.request("session.members.add", {
      sessionKey: approvalKey,
      identityId: approver.profileId,
    });
    await owner.request("session.members.add", {
      sessionKey: approvalKey,
      identityId: writer.profileId,
    });
    const requestedIds = (list: GatewayEvent[]) =>
      list.flatMap(({ event, payload }) =>
        event === "exec.approval.requested" &&
        payload &&
        typeof payload === "object" &&
        typeof (payload as { id?: unknown }).id === "string"
          ? [(payload as { id: string }).id]
          : [],
      );
    const awaitApproval = async (seen: Set<string>) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = requestedIds(ownerEvents).find((candidate) => !seen.has(candidate));
        if (id) {
          seen.add(id);
          return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return undefined;
    };
    const seen = new Set<string>();
    const resolve = (client: Client, id: string, decision: string) =>
      settle(client.request("exec.approval.resolve", { id, decision })).then((r) =>
        r.ok ? "resolved" : r.error,
      );
    const listed_ = async (client: Client, id: string) =>
      settle(
        client
          .request<Array<{ id: string }>>("exec.approval.list", {})
          .then((r) => r.some((item) => item.id === id)),
      ).then((r) => (r.ok ? r.value : r.error));
    const ownTurn = await settle(
      approver.client.request("chat.send", {
        sessionKey: approvalKey,
        message: "please RUN_EXEC",
        idempotencyKey: `approver-exec-${mode}`,
      }),
    );
    report.check4ApproverTurn = ownTurn.ok ? "accepted" : ownTurn.error;
    const ownId = ownTurn.ok ? await awaitApproval(seen) : undefined;
    report.check4ApproverApprovalRaised = Boolean(ownId);
    if (ownId) {
      const id = ownId;
      report.check4ApproverSawRequestedEvent = requestedIds(
        events.get(members.approver.origin)!,
      ).includes(id);
      report.check4ApproverListsOwnApproval = await listed_(approver.client, id);
      report.check4WriterWithoutApprovalsScope = await resolve(writer.client, id, "deny");
      report.check4ApproverResolvesOwn = await resolve(approver.client, id, "allow-once");
      if (report.check4ApproverResolvesOwn !== "resolved") {
        await resolve(owner, id, "deny");
      }
    }
    const ownerTurn = await settle(
      owner.request("chat.send", {
        sessionKey: approvalKey,
        message: "owner RUN_EXEC",
        idempotencyKey: `owner-exec-${mode}`,
      }),
    );
    report.check4OwnerTurn = ownerTurn.ok ? "accepted" : ownerTurn.error;
    const ownerId = ownerTurn.ok ? await awaitApproval(seen) : undefined;
    report.check4OwnerApprovalRaised = Boolean(ownerId);
    if (ownerId) {
      const id = ownerId;
      report.check4ApproverListsOwnersApproval = await listed_(approver.client, id);
      report.check4ApproverResolvesOwners = await resolve(approver.client, id, "deny");
      if (report.check4ApproverResolvesOwners !== "resolved") {
        await resolve(owner, id, "deny");
      }
    }
    return report;
  } finally {
    for (const client of clients) {
      await client.stopAndWait();
    }
    await server?.close();
    intercepted.mockRestore();
    await closeProvider(provider);
    await state.cleanup();
  }
}

// Members get permissions from their OpenClaw ID membership role, never their profile role.
it.for<Mode>([
  "enforcement-off",
  "enforcement-on-permissive-default",
  "enforcement-on-denying-default",
])(
  "OpenClaw ID members invited by mention follow their membership role (%s)",
  async (mode, { signal }) => {
    const report = await runScenario(mode, signal);
    // Mention invitations: expected behavior, red today (recipient judged by profile/default role).
    expect.soft(report.mentionable, "mention picker").toEqual({
      guest: true,
      guest2: true,
      writer: true,
      writer2: true,
    });
    expect.soft(report.mentionSend, "mention send").toBe("accepted");
    expect.soft(report.membersAfterMention, "invitation membership").toEqual({
      guest: true,
      guest2: true,
      writer: true,
      writer2: true,
    });
    expect.soft(report.visibleAfterMention, "visibility after mention").toEqual({
      guest: { invited: true, other: false, otherAgent: false },
      guest2: { invited: true, other: false, otherAgent: false },
      writer: { invited: true, other: false, otherAgent: false },
      writer2: { invited: true, other: false, otherAgent: false },
    });

    // Checks 1 and 2 use explicit membership and hold today.
    expect(report.visibleAfterExplicitAdd).toEqual({
      guest: { invited: true, other: false, otherAgent: false },
      guest2: { invited: true, other: false, otherAgent: false },
      // Invited into the other agent's session too: visible, but its turns are refused below.
      writer: { invited: true, other: false, otherAgent: true },
    });
    expect(report.guestHistory).toBe(true);
    expect(report.check1GuestSandboxedTurn).toBe("Session-scoped writes require your own session.");
    expect(report.check1GuestUnsandboxedTurn).toBe(
      "Session-scoped writes require your own session.",
    );
    expect(report.check2WriterInvitedTurn).toBe("accepted");
    expect(report.check2SandboxedWriterInvitedTurn).toMatch(/requires a sandboxed session/);
    expect(report.check2WriterOtherSessionTurn).toMatch(/was not found/);
    expect(report.check2WriterOtherAgentTurn).toMatch(/cannot create sessions for agent "other"/);
    // Check 3: operator.write alone moves an invited owner session between non-full modes,
    // including loosening read-only, even for a sandbox-required role; full needs admin.
    expect({
      guardedToWorkspace: report.check3WriterGuardedToWorkspace,
      toFull: report.check3WriterToFull,
      loosenReadOnly: report.check3WriterLoosensReadOnly,
      sessionsWriteOnly: report.check3GuestLoosensReadOnly,
      sandboxedWriter: report.check3SandboxedWriterLoosensReadOnly,
    }).toEqual({
      guardedToWorkspace: "accepted (now workspace)",
      toFull: "missing scope: operator.admin",
      loosenReadOnly: "accepted (now workspace)",
      sessionsWriteOnly: "Session-scoped writes require your own session.",
      sandboxedWriter: "accepted (now workspace)",
    });

    // Check 4: operator.approvals resolves any approval in a readable invited session,
    // the member's own and the owner's alike; without the scope the resolve is refused.
    expect({
      raised: report.check4ApproverApprovalRaised,
      listed: report.check4ApproverListsOwnApproval,
      withoutScope: report.check4WriterWithoutApprovalsScope,
      own: report.check4ApproverResolvesOwn,
      ownersListed: report.check4ApproverListsOwnersApproval,
      owners: report.check4ApproverResolvesOwners,
    }).toEqual({
      raised: true,
      listed: true,
      withoutScope: "missing scope: operator.approvals",
      own: "resolved",
      ownersListed: true,
      owners: "resolved",
    });
  },
);
