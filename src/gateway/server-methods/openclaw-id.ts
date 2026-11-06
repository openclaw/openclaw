import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { Ed25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { isEd25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
// OpenClaw ID remote access methods. The root ceremony (the link ceremony "Make
// reachable") runs only for a direct-loopback client;
// relayed clients can read status and send owner-signed membership changes, which
// the authority verifies itself. Status is the same small summary for every client;
// people, devices and activity come only from openclawId.people, for an owner.
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import {
  resolveOpenClawIdClientChannel,
  resolveOpenClawIdClientPeerKey,
} from "../openclaw-id/channel.js";
import { decodeInviteProofKey } from "../openclaw-id/invites-view.js";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// Responds with the service, or an unavailable error when this Gateway has none.
function requireService(opts: GatewayRequestHandlerOptions) {
  const service = opts.context.openclawIdService;
  if (!service) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw ID is unavailable"),
    );
  }
  return service;
}

// Maps an authority refusal to an RPC error with a stable code in details.
function refuse(opts: GatewayRequestHandlerOptions, result: { code: string; detail: string }) {
  opts.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, result.detail, { details: { code: result.code } }),
  );
}

function optionalCode(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Whether the calling client is an owner (see OpenClawIdService.isOwnerClient).
async function isOwnerCaller(service: OpenClawIdService, opts: GatewayRequestHandlerOptions) {
  return await service.isOwnerClient(
    resolveOpenClawIdClientChannel(opts.client),
    resolveOpenClawIdClientPeerKey(opts.client),
  );
}

// Link state after a write: the owner view for an owner, otherwise the summary.
async function linkAfterWrite(service: OpenClawIdService, opts: GatewayRequestHandlerOptions) {
  return (await isOwnerCaller(service, opts))
    ? await service.linkStatus()
    : await service.linkSummary();
}

export const openclawIdHandlers: GatewayRequestHandlers = {
  "openclawId.status": async (opts) => {
    const service = requireService(opts);
    if (!service) {
      return;
    }
    const config = opts.context.getRuntimeConfig().gateway?.openclawId;
    const ownerCheck = await service.prepareOwnerClientCheck(
      resolveOpenClawIdClientChannel(opts.client),
      resolveOpenClawIdClientPeerKey(opts.client),
    );
    const ownerDeviceCount = ownerCheck() ? await service.ownerDeviceCount() : undefined;
    const connection = await service.connectionIdentity(
      resolveOpenClawIdClientChannel(opts.client),
      resolveOpenClawIdClientPeerKey(opts.client),
    );
    const link = await service.linkSummary();
    const owner = ownerCheck();
    opts.respond(true, {
      status: service.status(),
      link,
      channel: resolveOpenClawIdClientChannel(opts.client) ?? null,
      // Whether openclawId.people will answer this client.
      owner,
      ...(owner ? { ownerDeviceCount: ownerDeviceCount ?? 0 } : {}),
      // Who this connection is (the account menu): loopback, owner device or member.
      connection,
      services: {
        issuerUrl: config?.issuerUrl ?? null,
        discoveryUrl: config?.discoveryUrl ?? null,
        loaderDomain: config?.loaderDomain ?? null,
        clientId: config?.clientId ?? null,
      },
    });
  },

  // Owner-only link state: active owner devices, members with their activity,
  // invites and the publication. Answers the direct-loopback operator and a tunnel
  // client whose device key is an active owner device right now; members and any
  // other client are refused even with the method's scope.
  "openclawId.people": async (opts) => {
    const service = requireService(opts);
    if (!service) {
      return;
    }
    const ownerCheck = await service.prepareOwnerClientCheck(
      resolveOpenClawIdClientChannel(opts.client),
      resolveOpenClawIdClientPeerKey(opts.client),
    );
    if (!ownerCheck()) {
      refuse(opts, { code: "not_owner", detail: "only an owner device of this claw sees people" });
      return;
    }
    const link = await service.linkStatus();
    if (!ownerCheck()) {
      refuse(opts, { code: "not_owner", detail: "only an owner device of this claw sees people" });
      return;
    }
    opts.respond(true, { link });
  },

  // Writes to the membership authority, by action:
  // - check_name / prepare / commit: the local link ceremony ("Make reachable"),
  //   direct loopback only. check_name and prepare take the owner's link code and
  //   claw name; Discovery assigns the address "<name>-<account tag>.<domain>";
  // - publish: (re)publish to Discovery, optionally with an enrollment code;
  // - submit: an owner-signed statement (MembershipChange, Revocation, root
  //   re-certification of a known device) sent directly over the tunnel or loopback.
  //   The authority verifies signature, capability and seq; the mailbox never
  //   reaches here. Approving (`add` with invite_id) or denying (`deny_invite`) a
  //   pending redemption is a submit too. A claw's root never changes: there is no
  //   owner reset in this version (OCF-319);
  // - register_invite: an owner-signed InviteCap and its base64url proof key.
  "openclawId.authority": async (opts) => {
    if (!isOpenClawIdEnabled(opts.context.getRuntimeConfig().gateway?.openclawId)) {
      opts.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw ID is off"));
      return;
    }
    const service = requireService(opts);
    if (!service) {
      return;
    }
    const params = isRecord(opts.params) ? opts.params : {};
    if (params.action === "device_mail") {
      const { handleOpenClawIdDeviceMail } = await import("./openclaw-id-device-mail.js");
      await handleOpenClawIdDeviceMail(opts, service);
      return;
    }
    const channel = resolveOpenClawIdClientChannel(opts.client);
    const nameRequest = {
      enrollmentCode: optionalCode(params.enrollmentCode),
      name: optionalCode(params.name),
    };
    if (params.action === "check_name") {
      const result = await service.checkClawName(channel, nameRequest);
      if ("ok" in result) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, result);
      return;
    }
    if (params.action === "prepare") {
      const result = await service.prepareLink(channel, nameRequest);
      if ("ok" in result) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, result);
      return;
    }
    if (params.action === "publish") {
      // Publication results name the owner account, so only a current owner may publish.
      const ownerCheck = await service.prepareOwnerClientCheck(
        channel,
        resolveOpenClawIdClientPeerKey(opts.client),
      );
      if (!ownerCheck()) {
        refuse(opts, { code: "not_owner", detail: "only an owner device of this claw publishes" });
        return;
      }
      const publication = await service.publish(optionalCode(params.enrollmentCode));
      if (!ownerCheck()) {
        refuse(opts, { code: "not_owner", detail: "only an owner device of this claw publishes" });
        return;
      }
      opts.respond(true, { publication: publication ?? null });
      return;
    }
    if (params.action === "submit") {
      const result = await service.submitStatement(channel, params.statement);
      if (!result.ok) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, {
        status: result.status,
        // What a removal cut (connections closed, runs stopped); absent otherwise.
        removal: result.removal ?? null,
        link: await linkAfterWrite(service, opts),
      });
      return;
    }
    if (params.action === "register_invite") {
      const proofKey = decodeInviteProofKey(params.proofKey);
      if (!params.cap || !proofKey) {
        refuse(opts, { code: "malformed", detail: "cap and a 32-byte proofKey are required" });
        return;
      }
      const result = await service.registerInvite(channel, { cap: params.cap, proofKey });
      if (!result.ok) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, { status: result.status, link: await linkAfterWrite(service, opts) });
      return;
    }
    if (params.action !== "commit") {
      refuse(opts, {
        code: "malformed",
        detail: "action must be check_name, prepare, commit, publish, submit or register_invite",
      });
      return;
    }
    if (!isEd25519PublicKey(params.rootPub) || !params.ownerDevice || !params.binding) {
      refuse(opts, { code: "malformed", detail: "rootPub, ownerDevice and binding are required" });
      return;
    }
    const result = await service.commitLink(
      channel,
      {
        // SAFETY: checked by isEd25519PublicKey above.
        root_pub: params.rootPub as Ed25519PublicKey,
        owner_device: params.ownerDevice,
        binding: params.binding,
      },
      optionalCode(params.enrollmentCode),
    );
    if (!result.ok) {
      refuse(opts, result);
      return;
    }
    opts.respond(true, { linked: true, publication: result.publication ?? null });
  },
};
