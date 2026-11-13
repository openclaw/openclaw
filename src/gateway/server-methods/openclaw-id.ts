import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { Ed25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { isEd25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
// OpenClaw ID remote access methods. The root ceremony (the link ceremony "Make
// reachable") runs only for a direct-loopback client;
// relayed clients can read status and send owner-signed membership changes, which
// the authority verifies itself. Status is the same small summary for every client;
// people, devices and activity come only from openclawId.people, for an owner.
import { VERSION } from "../../version.js";
import { createOpenClawIdSignIn, type OpenClawIdSignIn } from "../openclaw-id/account-sign-in.js";
import {
  resolveOpenClawIdClientChannel,
  resolveOpenClawIdClientPeerKey,
  resolveOpenClawIdSignInRoute,
} from "../openclaw-id/channel.js";
import { decodeInviteProofKey } from "../openclaw-id/invites-view.js";
import { resolveOpenClawIdOwnerAccount } from "../openclaw-id/owner-account.js";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
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

// Pending Control UI sign-ins live only in this process, for ten minutes each.
const accountSignIn = createOpenClawIdSignIn();

// Responds with a sign-in step's result, or maps its refusal to an RPC error.
function respondSignIn(
  opts: GatewayRequestHandlerOptions,
  result: Awaited<
    ReturnType<
      OpenClawIdSignIn["begin" | "complete" | "enrollmentCode" | "beginDevice" | "pollDevice"]
    >
  >,
) {
  if ("ok" in result && !result.ok) {
    refuse(opts, result);
    return;
  }
  opts.respond(true, result);
}

// The Control UI's OpenClaw ID account on the direct-loopback operator, by action:
// - account_begin: PKCE authorization URL for the sign-in popup (redirectUri
//   ends with /openclaw-id/callback on the Control UI origin);
// - account_complete: redeems the popup's code once; returns the account and ID token;
// - account_link_code: a Discovery link code for the signed-in account, so Make
//   reachable needs no pasted code.
// Personal connections sign in through openclawId.account instead (handleDeviceAccount).
async function handleAccount(opts: GatewayRequestHandlerOptions, action: string) {
  const config = opts.context.getRuntimeConfig().gateway?.openclawId;
  if (config?.enabled !== true) {
    opts.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw ID is off"));
    return;
  }
  const route = resolveOpenClawIdSignInRoute(opts.client);
  const params = isRecord(opts.params) ? opts.params : {};
  if (route !== "popup") {
    refuse(opts, {
      code: "not_local_operator",
      detail: "Sign in with OpenClaw ID from the Control UI on this machine",
    });
    return;
  }
  try {
    if (action === "account_begin") {
      if (!config.issuerUrl || !config.clientId) {
        refuse(opts, { code: "unconfigured", detail: "set issuerUrl and clientId to sign in" });
        return;
      }
      respondSignIn(
        opts,
        await accountSignIn.begin({
          issuerUrl: config.issuerUrl,
          clientId: config.clientId,
          redirectUri: params.redirectUri,
        }),
      );
      return;
    }
    if (action === "account_complete") {
      const service = requireService(opts);
      if (!service) {
        return;
      }
      respondSignIn(
        opts,
        await accountSignIn.complete({
          state: params.state,
          code: params.code,
          onVerifiedAccount: (account) => service.recordVerifiedAccount(account),
        }),
      );
      return;
    }
    if (action === "account_link_code") {
      if (!config.discoveryUrl) {
        refuse(opts, { code: "unconfigured", detail: "set discoveryUrl to get a link code" });
        return;
      }
      respondSignIn(
        opts,
        await accountSignIn.enrollmentCode({
          discoveryUrl: config.discoveryUrl,
          idToken: params.idToken,
        }),
      );
      return;
    }
    refuse(opts, { code: "malformed", detail: `unknown account action ${action}` });
  } catch (error) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `OpenClaw ID sign-in failed: ${String(error)}`),
    );
  }
}

// Whether `opts.client` is still the live personal connection of profile `owner`, with
// OpenClaw ID on: checked again right before an account leaves the Gateway.
function isCurrentDeviceSignIn(opts: GatewayRequestHandlerOptions, owner: string): boolean {
  return (
    opts.context.getRuntimeConfig().gateway?.openclawId?.enabled === true &&
    hasCurrentPersonalGatewaySource(opts.client, opts.context) &&
    resolveOpenClawIdSignInRoute(opts.client) === "device" &&
    opts.client.authenticatedUserProfile?.profileId === owner
  );
}

// Captures the caller's live authority over its own profile for a link change: the current
// personal source and profile, the device route and the Labs switch. Refuses and returns
// undefined when any is already gone.
async function prepareProfileLink(
  opts: GatewayRequestHandlerOptions,
  owner: string,
): Promise<(() => void) | undefined> {
  const assertRoute = () => {
    if (
      opts.context.getRuntimeConfig().gateway?.openclawId?.enabled !== true ||
      resolveOpenClawIdSignInRoute(opts.client) !== "device" ||
      opts.client?.authenticatedUserProfile?.profileId !== owner
    ) {
      throw new Error("this connection changed");
    }
  };
  try {
    assertRoute();
    const action = await preparePersonalProfileAction(opts);
    if (action.owner !== owner) {
      throw new Error("this connection changed");
    }
    return () => {
      action.assertCurrent();
      assertRoute();
    };
  } catch {
    refuse(opts, { code: "not_personal_connection", detail: "this connection changed" });
    return undefined;
  }
}

// Sign in with OpenClaw ID on a connection with a verified personal profile (see
// resolveOpenClawIdSignInRoute), by action. It needs only read scope: the account proves
// which OpenClaw ID this browser holds, is never recorded in the claw record, and grants
// nothing.
// - device_begin: a device sign-in's user code and verification page;
// - device_poll: polls it once; returns pending, or the account and ID token. With
//   `link: true`, the verified account is also linked to this connection's profile
//   (OCF-510): both sides are proven on this one connection, so there is no picker.
//   Owner devices of a linked account then arrive as this profile;
// - link_status: the OpenClaw ID accounts linked to this connection's profile;
// - unlink: removes them; owner devices return to the shared owner.
async function handleDeviceAccount(opts: GatewayRequestHandlerOptions) {
  const config = opts.context.getRuntimeConfig().gateway?.openclawId;
  if (config?.enabled !== true) {
    opts.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw ID is off"));
    return;
  }
  const params = isRecord(opts.params) ? opts.params : {};
  const owner = opts.client?.authenticatedUserProfile?.profileId;
  if (resolveOpenClawIdSignInRoute(opts.client) !== "device" || !owner) {
    refuse(opts, {
      code: "not_personal_connection",
      detail: "Sign in with OpenClaw ID through a personal sign-in such as Tailscale",
    });
    return;
  }
  try {
    if (params.action === "device_begin") {
      if (!config.issuerUrl || !config.clientId) {
        refuse(opts, { code: "unconfigured", detail: "set issuerUrl and clientId to sign in" });
        return;
      }
      respondSignIn(
        opts,
        await accountSignIn.beginDevice({
          issuerUrl: config.issuerUrl,
          clientId: config.clientId,
          owner,
        }),
      );
      return;
    }
    if (params.action === "device_poll") {
      const result = await accountSignIn.pollDevice({ state: params.state, owner });
      // The poll awaited the issuer: release the ID token only to the same live personal
      // connection, profile and Labs switch that started it. Otherwise it is discarded.
      if ("account" in result && !isCurrentDeviceSignIn(opts, owner)) {
        refuse(opts, { code: "not_personal_connection", detail: "this connection changed" });
        return;
      }
      if (params.link !== true || !("account" in result)) {
        respondSignIn(opts, result);
        return;
      }
      // The poll awaited the issuer: the write keeps the live personal source, profile and
      // Labs switch current through its commit.
      const assertCurrent = await prepareProfileLink(opts, owner);
      if (!assertCurrent) {
        return;
      }
      const { linkCanonicalOpenClawIdUserProfile } =
        await import("../../state/user-profile-openclaw-id.js");
      const linked = await linkCanonicalOpenClawIdUserProfile(
        { profileId: owner, accountId: result.account.sub, email: result.account.email },
        { assertCurrent },
      );
      // The write awaited the state worker; the token again leaves only to the same connection.
      if (!isCurrentDeviceSignIn(opts, owner)) {
        refuse(opts, { code: "not_personal_connection", detail: "this connection changed" });
        return;
      }
      opts.respond(true, { ...result, link: linked.ok ? "linked" : linked.code });
      return;
    }
    if (params.action === "link_status") {
      const { readOpenClawIdLinksOfProfile } =
        await import("../../state/user-profile-openclaw-id.js");
      const ownerAccount = resolveOpenClawIdOwnerAccount();
      // Account IDs stay on the Gateway; the row shows each email and the claw role.
      opts.respond(true, {
        linked: (await readOpenClawIdLinksOfProfile(owner)).map((link) => ({
          email: link.email,
          owner: link.accountId === ownerAccount,
        })),
      });
      return;
    }
    if (params.action === "unlink") {
      const assertCurrent = await prepareProfileLink(opts, owner);
      if (!assertCurrent) {
        return;
      }
      const { unlinkCanonicalOpenClawIdUserProfile } =
        await import("../../state/user-profile-openclaw-id.js");
      opts.respond(
        true,
        await unlinkCanonicalOpenClawIdUserProfile({ profileId: owner }, { assertCurrent }),
      );
      return;
    }
    refuse(opts, { code: "malformed", detail: `unknown account action ${String(params.action)}` });
  } catch (error) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `OpenClaw ID sign-in failed: ${String(error)}`),
    );
  }
}

export const openclawIdHandlers: GatewayRequestHandlers = {
  "openclawId.account": handleDeviceAccount,
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
      // How this connection signs in with OpenClaw ID: popup (loopback), device or not at all.
      accountSignIn: resolveOpenClawIdSignInRoute(opts.client),
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
  // - register_invite: an owner-signed InviteCap and its base64url proof key;
  // - register_node_invite: an owner-signed NodeInviteCap and its base64url proof key;
  // - rebind_prepare / rebind_commit / rebind_cancel: "Move to new keys", direct loopback
  //   only. prepare stages the next K_srv and K_gw and returns the binding the owner root
  //   signs, with Discovery's published descriptor when `code` (the owner account's link code)
  //   reads it; commit takes that R-signed binding and the code that publishes it; cancel
  //   deletes uncommitted staged keys;
  // - account_*: the Control UI's OpenClaw ID sign-in (see handleAccount).
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
    if (typeof params.action === "string" && params.action.startsWith("account_")) {
      await handleAccount(opts, params.action);
      return;
    }
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
    if (params.action === "register_invite" || params.action === "register_node_invite") {
      const proofKey = decodeInviteProofKey(params.proofKey);
      if (!params.cap || !proofKey) {
        refuse(opts, { code: "malformed", detail: "cap and a 32-byte proofKey are required" });
        return;
      }
      const input = { cap: params.cap, proofKey };
      const result =
        params.action === "register_node_invite"
          ? await service.registerNodeInvite(channel, input)
          : await service.registerInvite(channel, input);
      if (!result.ok) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, {
        status: result.status,
        link: await linkAfterWrite(service, opts),
        ...(params.action === "register_node_invite"
          ? {
              discoveryUrl:
                opts.context.getRuntimeConfig().gateway?.openclawId?.discoveryUrl ?? null,
              version: VERSION,
            }
          : {}),
      });
      return;
    }
    if (
      params.action === "rebind_prepare" ||
      params.action === "rebind_commit" ||
      params.action === "rebind_cancel"
    ) {
      if (channel !== "local_operator") {
        refuse(opts, {
          code: "not_local_operator",
          detail: "Move to new keys only works on the computer running this claw",
        });
        return;
      }
      const result = await service.rebind(
        params.action === "rebind_prepare"
          ? "prepare"
          : params.action === "rebind_commit"
            ? "commit"
            : "cancel",
        channel,
        { binding: params.binding, code: optionalCode(params.code) },
      );
      if ("ok" in result && !result.ok) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, result);
      return;
    }
    if (params.action !== "commit") {
      refuse(opts, {
        code: "malformed",
        detail:
          "action must be check_name, prepare, commit, publish, submit, register_invite, register_node_invite or rebind_*",
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
