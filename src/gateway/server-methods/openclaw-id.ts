import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { Ed25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { isEd25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
// OpenClaw ID remote access methods. The root ceremony (the link ceremony "Make
// reachable") runs for the direct-loopback operator or an admin with a verified personal
// identity (openclaw-id-remote-access.ts); relayed clients never run it. They can read
// status and send owner-signed membership changes, which the authority verifies itself.
// Status is the same small summary for every client; people, devices and activity come only
// from openclawId.people, for an owner.
import { VERSION } from "../../version.js";
import {
  createOpenClawIdSignIn,
  type OpenClawIdSignIn,
  type OpenClawIdSignInRefusal,
} from "../openclaw-id/account-sign-in.js";
import type { AuthorityRefusal } from "../openclaw-id/authority-result.js";
import {
  resolveOpenClawIdClientChannel,
  resolveOpenClawIdClientPeerKey,
  resolveOpenClawIdSignInRoute,
} from "../openclaw-id/channel.js";
import type { OpenClawIdAccount } from "../openclaw-id/claw-store.js";
import { decodeInviteProfile, decodeInviteProofKey } from "../openclaw-id/invites-view.js";
import { resolveOpenClawIdOwnerAccount } from "../openclaw-id/owner-account.js";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import {
  auditRemoteAccessSetup,
  prepareRemoteAccessSetup,
  resolveRemoteAccessSetupRoute,
  type RemoteAccessSetup,
} from "./openclaw-id-remote-access.js";
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

// Whether a ceremony caller's authority is still live.
function isCurrent(setup: RemoteAccessSetup): boolean {
  try {
    setup.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

// Runs a guarded ceremony write; a write the caller's lost authority stopped becomes a refusal.
async function guarded<T>(
  setup: RemoteAccessSetup,
  run: () => Promise<T>,
): Promise<T | AuthorityRefusal> {
  try {
    return await run();
  } catch (error) {
    if (!isCurrent(setup)) {
      return { ok: false, code: "not_admin", detail: "this connection changed" };
    }
    throw error;
  }
}

function refuseChanged(
  opts: GatewayRequestHandlerOptions,
  action: string,
  setup: RemoteAccessSetup,
) {
  auditRemoteAccessSetup(opts, { action, setup, outcome: "denied", code: "not_admin" });
  refuse(opts, { code: "not_admin", detail: "this connection changed" });
}

// Admits a step of Turn on remote access (check_name, prepare, commit), or refuses and
// records the refusal.
async function admitCeremony(
  opts: GatewayRequestHandlerOptions,
  action: string,
): Promise<RemoteAccessSetup | undefined> {
  const setup = await prepareRemoteAccessSetup(opts);
  if ("ok" in setup) {
    auditRemoteAccessSetup(opts, { action, setup: null, outcome: "denied", code: setup.code });
    refuse(opts, setup);
    return undefined;
  }
  return setup;
}

// A Discovery link code for the browser's signed-in account, so Turn on remote access and
// Publish new keys need no pasted code. Only for a caller that may run the ceremony.
async function handleLinkCode(
  opts: GatewayRequestHandlerOptions,
  discoveryUrl: string | undefined,
  idToken: unknown,
) {
  const setup = await admitCeremony(opts, "link_code");
  if (!setup) {
    return;
  }
  if (!discoveryUrl) {
    refuse(opts, { code: "unconfigured", detail: "set discoveryUrl to get a link code" });
    return;
  }
  try {
    const code = await accountSignIn.enrollmentCode({ discoveryUrl, idToken });
    if (!isCurrent(setup)) {
      refuseChanged(opts, "link_code", setup);
      return;
    }
    const failed = "ok" in code ? code.code : undefined;
    auditRemoteAccessSetup(opts, {
      action: "link_code",
      setup,
      outcome: failed ? "failure" : "success",
      ...(failed ? { code: failed } : {}),
    });
    respondSignIn(opts, code);
  } catch (error) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `OpenClaw ID sign-in failed: ${String(error)}`),
    );
  }
}

// After a personal admin's commit: links the OpenClaw ID this browser signed in with (a
// sign-in this Gateway redeemed for the same profile, verifyHeldOpenClawIdSignIn from OCF-530)
// to the admin's profile, so their owner devices arrive as them, and keeps its display claims
// for the claw. Both sides are proven on this one connection, so there is no picker. The claw
// stays linked whatever this returns: "linked", or why the profile was not linked.
async function linkRunnerProfile(
  opts: GatewayRequestHandlerOptions,
  service: OpenClawIdService,
  setup: RemoteAccessSetup,
  idToken: unknown,
): Promise<string> {
  const held = verifyHeldOpenClawIdSignIn(opts, idToken);
  if ("ok" in held) {
    return held.code;
  }
  if (held.owner !== setup.profileId) {
    return "not_admin";
  }
  try {
    setup.assertCurrent();
    await service.recordVerifiedAccount(held.account);
    const { linkCanonicalOpenClawIdUserProfile } =
      await import("../../state/user-profile-openclaw-id.js");
    const linked = await linkCanonicalOpenClawIdUserProfile(
      { profileId: held.owner, accountId: held.account.sub, email: held.account.email },
      { assertCurrent: setup.assertCurrent },
    );
    return linked.ok ? "linked" : linked.code;
  } catch {
    return "not_admin";
  }
}

// The Control UI's OpenClaw ID account on the direct-loopback operator, by action:
// - account_begin: PKCE authorization URL for the sign-in popup (redirectUri
//   ends with /openclaw-id/callback on the Control UI origin);
// - account_complete: redeems the popup's code once; returns the account and ID token;
// - account_link_code: a Discovery link code for the signed-in account, so Make
//   reachable needs no pasted code. Also for a personal admin (handleLinkCode).
// Personal connections sign in through openclawId.account instead (handleDeviceAccount).
async function handleAccount(opts: GatewayRequestHandlerOptions, action: string) {
  const config = opts.context.getRuntimeConfig().gateway?.openclawId;
  if (config?.enabled !== true) {
    opts.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw ID is off"));
    return;
  }
  const route = resolveOpenClawIdSignInRoute(opts.client);
  const params = isRecord(opts.params) ? opts.params : {};
  if (action === "account_link_code") {
    await handleLinkCode(opts, config.discoveryUrl, params.idToken);
    return;
  }
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

/**
 * The OpenClaw ID account a personal connection's browser still holds from a device sign-in
 * this Gateway redeemed for the same profile, so a follow-on step needs no second device code.
 * Refuses unless OpenClaw ID is on and configured and `opts.client` is the live personal
 * connection of that profile; `sign_in_not_held` (unknown, expired or another profile's token)
 * means sign in again with the device flow.
 */
export function verifyHeldOpenClawIdSignIn(
  opts: GatewayRequestHandlerOptions,
  idToken: unknown,
): { owner: string; account: OpenClawIdAccount } | OpenClawIdSignInRefusal {
  const config = opts.context.getRuntimeConfig().gateway?.openclawId;
  const owner = opts.client?.authenticatedUserProfile?.profileId;
  if (!owner || !isCurrentDeviceSignIn(opts, owner)) {
    return {
      ok: false,
      code: "not_personal_connection",
      detail: "Sign in with OpenClaw ID through a personal sign-in such as Tailscale",
    };
  }
  if (!config?.issuerUrl || !config.clientId) {
    return { ok: false, code: "unconfigured", detail: "set issuerUrl and clientId to sign in" };
  }
  const held = accountSignIn.verifyHeld({
    idToken,
    owner,
    issuerUrl: config.issuerUrl,
    clientId: config.clientId,
  });
  return "account" in held ? { owner, account: held.account } : held;
}

// Links a verified `account` to `owner`'s profile on this connection, keeping the live
// personal source, profile and Labs switch current through the write's commit. Returns the
// write's outcome, or undefined after refusing because the connection changed.
async function linkVerifiedAccount(
  opts: GatewayRequestHandlerOptions,
  owner: string,
  account: OpenClawIdAccount,
): Promise<string | undefined> {
  const assertCurrent = await prepareProfileLink(opts, owner);
  if (!assertCurrent) {
    return undefined;
  }
  const { linkCanonicalOpenClawIdUserProfile } =
    await import("../../state/user-profile-openclaw-id.js");
  const linked = await linkCanonicalOpenClawIdUserProfile(
    { profileId: owner, accountId: account.sub, email: account.email },
    { assertCurrent },
  );
  // The write awaited the state worker; its result leaves only to the same connection.
  if (!isCurrentDeviceSignIn(opts, owner)) {
    refuse(opts, { code: "not_personal_connection", detail: "this connection changed" });
    return undefined;
  }
  return linked.ok ? "linked" : linked.code;
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
// - link_held: links the same way with the ID token this browser still holds from such a
//   sign-in (OCF-530), so Link after sign-in needs no second code. `sign_in_not_held` tells
//   the browser to fall back to device_begin with `link`;
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
      const link = await linkVerifiedAccount(opts, owner, result.account);
      if (link) {
        opts.respond(true, { ...result, link });
      }
      return;
    }
    if (params.action === "link_held") {
      const held = verifyHeldOpenClawIdSignIn(opts, params.idToken);
      if ("ok" in held) {
        refuse(opts, held);
        return;
      }
      const link = await linkVerifiedAccount(opts, owner, held.account);
      if (link) {
        opts.respond(true, { account: held.account, link });
      }
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
    // Who may turn on remote access here; a personal admin who is not an owner also sees the
    // publication, for Publish new keys.
    const remoteAccessSetup = resolveRemoteAccessSetupRoute(opts.client);
    const setup =
      remoteAccessSetup === "personal_admin" && link.linked && !ownerCheck()
        ? await prepareRemoteAccessSetup(opts)
        : undefined;
    const publication =
      setup && !("ok" in setup) ? (await service.linkStatus()).publication : undefined;
    const owner = ownerCheck();
    opts.respond(true, {
      remoteAccessSetup,
      ...(publication && setup && !("ok" in setup) && isCurrent(setup) ? { publication } : {}),
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
  // - check_name / prepare / commit: the link ceremony ("Turn on remote access"), for the
  //   direct-loopback operator or an admin with a verified personal identity, never over
  //   the tunnel (openclaw-id-remote-access.ts). check_name and prepare take the owner's
  //   link code and claw name; Discovery assigns the address "<name>-<account tag>.<domain>".
  //   A personal admin's commit also takes `idToken` and links that OpenClaw ID to their
  //   profile. Every step is audit-logged with who ran it and over which identity;
  // - publish: (re)publish to Discovery, optionally with an enrollment code, for an owner
  //   or a caller who may turn on remote access;
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
    if (params.action === "check_name" || params.action === "prepare") {
      const action = params.action;
      const setup = await admitCeremony(opts, action);
      if (!setup) {
        return;
      }
      const result =
        action === "check_name"
          ? await service.checkClawName(setup.channel, nameRequest)
          : await guarded(setup, () =>
              service.prepareLink(setup.channel, { ...nameRequest, guard: setup.assertCurrent }),
            );
      if ("ok" in result) {
        auditRemoteAccessSetup(opts, {
          action,
          setup,
          outcome: result.code === "not_admin" ? "denied" : "failure",
          code: result.code,
        });
        refuse(opts, result);
        return;
      }
      if (!isCurrent(setup)) {
        refuseChanged(opts, action, setup);
        return;
      }
      if (action === "prepare") {
        auditRemoteAccessSetup(opts, { action, setup, outcome: "success" });
      }
      opts.respond(true, result);
      return;
    }
    if (params.action === "publish") {
      // Publication results name the owner account: a current owner, or someone who may turn
      // on remote access (publishing new keys with a link code is part of that ceremony).
      const ownerCheck = await service.prepareOwnerClientCheck(
        channel,
        resolveOpenClawIdClientPeerKey(opts.client),
      );
      const prepared = ownerCheck() ? undefined : await prepareRemoteAccessSetup(opts);
      const setup = prepared && !("ok" in prepared) ? prepared : undefined;
      const allowed = () => ownerCheck() || (setup !== undefined && isCurrent(setup));
      if (!allowed()) {
        if (prepared && "ok" in prepared) {
          auditRemoteAccessSetup(opts, {
            action: "publish",
            setup: null,
            outcome: "denied",
            code: prepared.code,
          });
        }
        refuse(opts, { code: "not_owner", detail: "only an owner device of this claw publishes" });
        return;
      }
      const publication = await service.publish(optionalCode(params.enrollmentCode));
      if (!allowed()) {
        refuse(opts, { code: "not_owner", detail: "only an owner device of this claw publishes" });
        return;
      }
      if (setup) {
        auditRemoteAccessSetup(opts, {
          action: "publish",
          setup,
          outcome: publication?.state === "failed" ? "failure" : "success",
          ...(publication?.state === "failed" ? { code: publication.code } : {}),
        });
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
    const isMemberInvite = params.action === "register_invite";
    if (isMemberInvite || params.action === "register_node_invite") {
      const proofKey = decodeInviteProofKey(params.proofKey);
      if (!params.cap || !proofKey) {
        refuse(opts, { code: "malformed", detail: "cap and a 32-byte proofKey are required" });
        return;
      }
      const profile = decodeInviteProfile(isMemberInvite ? params.existingProfileId : undefined);
      if ("ok" in profile) {
        return refuse(opts, profile);
      }
      const input = { cap: params.cap, proofKey, ...profile };
      const result = isMemberInvite
        ? await service.registerInvite(channel, input)
        : await service.registerNodeInvite(channel, input);
      if (!result.ok) {
        return refuse(opts, result);
      }
      opts.respond(true, {
        status: result.status,
        link: await linkAfterWrite(service, opts),
        ...(!isMemberInvite
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
    const setup = await admitCeremony(opts, "commit");
    if (!setup) {
      return;
    }
    const result = await guarded(setup, () =>
      service.commitLink(
        setup.channel,
        {
          // SAFETY: checked by isEd25519PublicKey above.
          root_pub: params.rootPub as Ed25519PublicKey,
          owner_device: params.ownerDevice,
          binding: params.binding,
        },
        optionalCode(params.enrollmentCode),
        setup.assertCurrent,
      ),
    );
    if (!result.ok) {
      auditRemoteAccessSetup(opts, {
        action: "commit",
        setup,
        outcome: result.code === "not_admin" ? "denied" : "failure",
        code: result.code,
      });
      refuse(opts, result);
      return;
    }
    auditRemoteAccessSetup(opts, { action: "commit", setup, outcome: "success" });
    const profileLink =
      setup.route === "personal_admin"
        ? await linkRunnerProfile(opts, service, setup, params.idToken)
        : null;
    if (profileLink) {
      auditRemoteAccessSetup(opts, {
        action: "link_profile",
        setup,
        outcome: profileLink === "linked" ? "success" : "failure",
        ...(profileLink === "linked" ? {} : { code: profileLink }),
      });
    }
    opts.respond(true, {
      linked: true,
      publication: result.publication ?? null,
      profileLink,
    });
  },
};
