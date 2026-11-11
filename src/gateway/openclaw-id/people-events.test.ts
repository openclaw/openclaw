import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  ROOT_EPOCH,
  signStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import {
  controllerSource,
  controllerTarget,
  controllerTurn,
} from "../../sessions/controller-core.test-support.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import { linkedClaw, ownerInvite, redemptionMail, serviceFor } from "./openclaw-id.test-support.js";
import { startOpenClawIdPeopleEvents } from "./people-events.js";

// Transport-shaped clients; admission/membership is the real persisted authority.
function client(connId: string, peerKey?: string, scopes = ["operator.admin"]): GatewayWsClient {
  return {
    connId,
    connect: { role: "operator", scopes, client: { id: "test" } },
    internal: { isLocalClient: true, ...(peerKey ? { openclawIdPeerKey: peerKey } : {}) },
  } as GatewayWsClient;
}

async function fixture() {
  const claw = await linkedClaw();
  const { service, effects, log } = serviceFor(claw.authority);
  await service.linkStatus();
  const local = client("local");
  const owner = client("owner", claw.w1);
  const clients = new GatewayClientRegistry([local, owner]);
  let receipt = createDeferredCore<{ event: string; payload: unknown; ids: string[] }>();
  const broadcast = vi.fn((event: string, payload: unknown, ids: ReadonlySet<string>) => {
    receipt.resolve({ event, payload, ids: [...ids] });
  });
  const events = startOpenClawIdPeopleEvents({
    clients,
    service,
    broadcastToConnIds: broadcast,
    log,
  });
  onTestFinished(async () => {
    events.stop();
    await service.stop();
  });
  return {
    claw,
    service,
    effects,
    clients,
    local,
    owner,
    events,
    broadcast,
    next: () => {
      receipt = createDeferredCore();
      return receipt.promise;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("OpenClaw ID People invalidations", () => {
  it("delivers connection/run changes only to current admin owners, never members or LAN readers", async () => {
    const h = await fixture();
    const invite = await ownerInvite(h.claw, { email: "member@example.test" });
    const registered = h.next();
    await h.service.registerInvite("tunnel", { cap: invite.cap, proofKey: invite.proofKey });
    await registered;
    const mail = await redemptionMail({
      clawId: h.claw.clawId,
      inviteId: invite.inviteId,
      proofKey: invite.proofKey,
      accountId: "member",
      email: "member@example.test",
    });
    const requested = h.next();
    await applyMailboxMessage(mail.message, {
      submit: (statement) => h.claw.authority.submit(statement, "mailbox"),
      redeem: (redemption, sender) => h.claw.authority.redeem(redemption, sender),
    });
    await requested;
    const admitted = h.next();
    await h.service.submitStatement(
      "tunnel",
      await h.claw.sign({
        op: "add",
        account_id: "member",
        role: "operator",
        peer_keys: [mail.peerKey],
        invite_id: invite.inviteId,
      }),
    );
    await admitted;
    const connected = h.next();
    const member = client("member-admin", mail.peerKey);
    h.clients.add(member);
    expect(await connected).toEqual({
      event: "openclawId.people.changed",
      payload: {},
      ids: ["local", "owner"],
    });
    const lan = client("lan");
    lan.internal = {};
    const lanAdded = h.next();
    h.clients.add(lan);
    await lanAdded;
    const readerAdded = h.next();
    h.clients.add(client("local-read", undefined, ["operator.read"]));
    await readerAdded;
    const run = h.next();
    notifyGatewayWorkMetricsChanged();
    expect((await run).ids).toEqual(["local", "owner"]);
    const disconnected = h.next();
    h.clients.delete(member);
    expect((await disconnected).ids).toEqual(["local", "owner"]);
    // A prepared guard must see the owner's later removal, not its preparation snapshot.
    const prepared = await h.service.prepareOwnerClientCheck("tunnel", h.claw.w1);
    const removal = await signStatement(
      "Revocation",
      {
        claw_id: h.claw.clawId,
        seq: 1,
        target_fp: await fingerprint(h.claw.cert.body.device_pub),
        target_kind: "owner_device",
        reason: "lost",
        root_epoch: ROOT_EPOCH,
        issued_at: Math.floor(Date.now() / 1000),
      },
      h.claw.root,
    );
    const changed = h.next();
    await h.claw.authority.submit(removal, "local_operator");
    expect(prepared()).toBe(false);
    expect((await changed).ids).toEqual(["local"]);
  });

  it("observes actual RPC input registration, execution start and settlement", async () => {
    const h = await fixture();
    const onlyLocal = h.next();
    h.clients.delete(h.owner);
    await onlyLocal;
    const target = controllerTarget("people-events", "agent:main:member", "member-session");
    const reserved = h.next();
    const input = controllerSource(target, { protocolRunId: "member-run" });
    onTestFinished(async () => {
      retireSessionControllerInput(input);
      await input.settlement.promise;
    });
    await reserved;
    const registered = h.next();
    registerRpcSource("member-run", {
      input,
      adapter: { kind: "chat-send", requester: { connectionId: "member" } },
    });
    await registered;
    let terminal: ReturnType<typeof h.next> | undefined;
    await withSessionTurn(
      { ...controllerTurn(target), controllerInput: input },
      async (operation) => {
        if (!operation) {
          throw new Error("expected admitted operation");
        }
        const started = h.next();
        markReplyOperationExecutionStarted(operation);
        expect((await started).ids).toEqual(["local"]);
        terminal = h.next();
      },
    );
    expect((await terminal)?.ids).toEqual(["local"]);
  });

  it("publishes every invite decision and removal after commit, before slow removal effects", async () => {
    const h = await fixture();
    const create = async () => {
      const invite = await ownerInvite(h.claw, { email: "member@example.test" });
      const changed = h.next();
      await h.service.registerInvite("tunnel", { cap: invite.cap, proofKey: invite.proofKey });
      await changed;
      expect(
        (await h.service.linkStatus()).invites?.some((item) => item.inviteId === invite.inviteId),
      ).toBe(true);
      const mail = await redemptionMail({
        clawId: h.claw.clawId,
        inviteId: invite.inviteId,
        proofKey: invite.proofKey,
        accountId: "member",
        email: "member@example.test",
      });
      const requested = h.next();
      await applyMailboxMessage(mail.message, {
        submit: (statement) => h.claw.authority.submit(statement, "mailbox"),
        redeem: (redemption, sender) => h.claw.authority.redeem(redemption, sender),
      });
      await requested;
      return { invite, mail };
    };
    const first = await create();
    const denied = h.next();
    await h.service.submitStatement(
      "tunnel",
      await h.claw.sign({ op: "deny_invite", invite_id: first.invite.inviteId }),
    );
    await denied;
    expect((await h.service.linkStatus()).invites?.[0]?.status).toBe("denied");
    const second = await create();
    const approved = h.next();
    await h.service.submitStatement(
      "tunnel",
      await h.claw.sign({
        op: "add",
        account_id: "member",
        role: "operator",
        peer_keys: [second.mail.peerKey],
        invite_id: second.invite.inviteId,
      }),
    );
    await approved;
    expect((await h.service.linkStatus()).members).toHaveLength(1);
    const stopped = createDeferredCore<number>();
    vi.mocked(h.effects.cancelRuns!).mockReturnValue(stopped.promise);
    const removal = await h.claw.sign({ op: "remove", account_id: "member" });
    const removed = h.next();
    const removing = h.service.submitStatement("tunnel", removal);
    await removed;
    expect((await h.service.linkStatus()).members).toHaveLength(0);
    stopped.resolve(1);
    await removing;
  });

  it("signals open and pending invite expiry with one-shot deadlines and stops timers", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
      now: Date.UTC(2026, 10, 1),
    });
    const h = await fixture();
    const invite = await ownerInvite(h.claw, { email: "member@example.test", expiresIn: 60 });
    const registered = h.next();
    await h.service.registerInvite("tunnel", { cap: invite.cap, proofKey: invite.proofKey });
    await registered;
    const expired = h.next();
    await vi.advanceTimersByTimeAsync(60_000);
    await expired;
    expect((await h.service.linkStatus()).invites?.[0]?.status).toBe("expired");
    const pendingInvite = await ownerInvite(h.claw, { email: "member@example.test" });
    const pendingRegistered = h.next();
    await h.service.registerInvite("tunnel", {
      cap: pendingInvite.cap,
      proofKey: pendingInvite.proofKey,
    });
    await pendingRegistered;
    const mail = await redemptionMail({
      clawId: h.claw.clawId,
      inviteId: pendingInvite.inviteId,
      proofKey: pendingInvite.proofKey,
      accountId: "member",
      email: "member@example.test",
    });
    const pendingRequested = h.next();
    await applyMailboxMessage(mail.message, {
      submit: (statement) => h.claw.authority.submit(statement, "mailbox"),
      redeem: (redemption, sender) => h.claw.authority.redeem(redemption, sender),
    });
    await pendingRequested;
    const pendingExpired = h.next();
    await vi.advanceTimersByTimeAsync(7 * 86_400_000);
    await pendingExpired;
    expect((await h.service.linkStatus()).invites?.every((item) => item.status === "expired")).toBe(
      true,
    );
    // Certificate display expiry must also invalidate while no tunnel runtime is running.
    const laptop = await generateEd25519Signer();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiring = await signStatement(
      "OwnerDeviceCert",
      {
        device_pub: formatEd25519PublicKey(laptop.publicKey),
        peer_keys: [formatIrohEndpointKey(randomBytes(32))],
        label: "laptop",
        scope: "owner",
        caps: [...OWNER_CAPABILITIES],
        issued_at: issuedAt,
        expires_at: issuedAt + 60,
        root_epoch: ROOT_EPOCH,
      },
      h.claw.root,
    );
    const added = h.next();
    await h.claw.authority.submit(
      await h.claw.sign({ op: "add_owner_device", cert: expiring }, h.claw.root),
      "local_operator",
    );
    await added;
    expect(await h.service.ownerDeviceCount()).toBe(2);
    const ownerExpired = h.next();
    await vi.advanceTimersByTimeAsync(60_000);
    await ownerExpired;
    expect(await h.service.ownerDeviceCount()).toBe(1);
    h.events.stop();
    await h.service.stop();
    const calls = h.broadcast.mock.calls.length;
    notifyGatewayWorkMetricsChanged();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(h.broadcast).toHaveBeenCalledTimes(calls);
  });
});
