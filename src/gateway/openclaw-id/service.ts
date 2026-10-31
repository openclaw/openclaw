// Gateway owner of experimental OpenClaw ID remote access (Labs).
// While the Labs switch is off this module does nothing: it starts no child
// process, opens no sockets and contacts no OpenClaw ID, Discovery or relay
// service. Everything heavier is imported only after the switch turns on.
import type { Server as HttpServer } from "node:http";
import type {
  AuthorityEvent,
  Channel,
  Ed25519PublicKey,
  IrohEndpointKey,
  OwnerKeyRegenerationPreparation,
  MemberRole,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type {
  AuthorityAccepted,
  AuthorityRefusal,
  LinkCommit,
  LinkPreparation,
  OpenClawIdAuthority,
  OwnerKeyRegeneration,
} from "./authority.js";
import { clawOriginOfRecord, setOpenClawIdClawOriginResolver } from "./claw-origin.js";
import type { StoredClaw } from "./claw-store.js";
import { setDeviceTokenBindingOwner } from "./device-token-binding.js";
import type { TunnelApiHandler } from "./ingress-listener.js";
import { listInviteViews } from "./invites-view.js";
import type { OpenClawIdPeerActivity } from "./member-activity.js";
import { createOwnerExpiryTimer } from "./owner-expiry.js";
import { createPublicationRetry } from "./publication-retry.js";
import type { PublishOutcome } from "./publisher.js";
import { setOpenClawIdTunnelPrincipalResolver } from "./tunnel-principal.js";
import type { TunnelRuntime, TunnelRuntimeSettings } from "./tunnel-runtime.js";
import type { TunnelSupervisorStatus } from "./tunnel-supervisor.js";

/** What the Control UI and `openclaw status` show for OpenClaw ID. */
export type OpenClawIdStatus =
  | { state: "off" }
  | { state: "unconfigured"; missing: Array<keyof GatewayOpenClawIdConfig> }
  | { state: "on"; tunnel: TunnelSupervisorStatus }
  | { state: "failed"; reason: string };

/** Side effects of membership changes that other Gateway owners perform. */
export type OpenClawIdEffects = {
  /**
   * Captures the Gateway connections relayed for these device keys. Called before
   * access is withdrawn, so their runs can still be found by connection.
   */
  captureConnections: (peerKeys: readonly string[]) => string[];
  /**
   * Cancels the active runs started over these connections; transcripts keep
   * the cut. Resolves with the number of runs it stopped.
   */
  cancelRuns?: (connectionIds: readonly string[]) => Promise<number>;
  /** Closes these Gateway connections. */
  closeConnections: (connectionIds: readonly string[]) => void;
  /** Revokes device tokens (device id and role) that were bound to removed keys. */
  revokeDeviceTokens: (tokens: ReadonlyArray<{ deviceId: string; role: string }>) => Promise<void>;
  /** Live activity of these device keys (connections, last seen, active runs). */
  describeActivity?: (peerKeys: readonly string[]) => Record<string, OpenClawIdPeerActivity>;
};

/** What an accepted removal cut, so the owner's page can say exactly what changed. */
export type OpenClawIdRemovalSummary = {
  /** Device keys whose access was withdrawn. */
  devices: number;
  /** Relayed Gateway connections that were closed. */
  connectionsClosed: number;
  /** Active runs that were stopped (transcripts keep the cut). */
  runsCancelled: number;
};

type OpenClawIdLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** True only for an explicit `gateway.openclawId.enabled: true`. */
export function isOpenClawIdEnabled(config: GatewayOpenClawIdConfig | undefined): boolean {
  return config?.enabled === true;
}

/** The settings a tunnel runtime needs, or the config keys still missing. */
function resolveSettings(
  config: GatewayOpenClawIdConfig,
  stateDir: string,
): TunnelRuntimeSettings | { missing: Array<keyof GatewayOpenClawIdConfig> } {
  if (!config.relayUrl) {
    return { missing: ["relayUrl"] };
  }
  return {
    stateDir,
    relayUrl: config.relayUrl,
    // Browsers reach a linked claw over the HTTPS loader origin.
    forwardedProto: config.loaderDomain ? "https" : "http",
  };
}

function sameSettings(a: TunnelRuntimeSettings, b: TunnelRuntimeSettings): boolean {
  return (
    a.stateDir === b.stateDir && a.relayUrl === b.relayUrl && a.forwardedProto === b.forwardedProto
  );
}

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

/** The owner's choice for "Make reachable": a one-time link code and a claw name. */
export type ClawNameRequest = { enrollmentCode?: string; name?: string };

/** The address Discovery assigns for a claw name, and whether it is free. */
export type ClawNameCheck = {
  name: string;
  accountTag: string;
  hostname: string;
  available: boolean;
};

/** Creates the OpenClaw ID owner. It stays inert until the Labs switch is on. */
export function createOpenClawIdService(params: {
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getStateDir: () => string;
  /** The Gateway's primary HTTP listener; relayed requests are handed to it. */
  getGatewayServer: () => HttpServer | undefined;
  log: OpenClawIdLogger;
  /** Test seam for the persisted authority. */
  createAuthority?: () => Promise<OpenClawIdAuthority>;
}) {
  let status: OpenClawIdStatus = { state: "off" };
  let runtime: TunnelRuntime | undefined;
  let authority: OpenClawIdAuthority | undefined;
  let lastPublish: PublishOutcome | undefined;
  let loadEffects: (() => Promise<OpenClawIdEffects>) | undefined;
  let effectsPromise: Promise<OpenClawIdEffects> | undefined;
  let mailbox: { stop(): void } | undefined;
  // Serializes start/stop so overlapping config reloads apply in order.
  let queue: Promise<void> = Promise.resolve();
  const ownerExpiry = createOwnerExpiryTimer({
    onExpired: () =>
      expireOwners().catch((error: unknown) =>
        params.log.warn(`openclaw-id: owner expiry failed: ${String(error)}`),
      ),
  });

  // Retries failed Discovery publications until the mirror catches up (OCF-313).
  const publicationRetry = createPublicationRetry({
    publish: () => publish(),
    current: () => authority?.current(),
    setPending: async (pending) =>
      await (await getAuthority()).recordDiscovery({ publish_pending: pending }),
    log: params.log,
  });

  // The removal effects load once; they also start remembering run custody.
  const getEffects = () => (effectsPromise ??= loadEffects?.());

  const getAuthority = async (): Promise<OpenClawIdAuthority> => {
    if (!authority) {
      authority = params.createAuthority
        ? await params.createAuthority()
        : (await import("./authority.js")).createOpenClawIdAuthority();
    }
    return authority;
  };

  const stopRuntime = async () => {
    const current = runtime;
    runtime = undefined;
    ownerExpiry.stop();
    publicationRetry.stop();
    mailbox?.stop();
    mailbox = undefined;
    setDeviceTokenBindingOwner(undefined);
    setOpenClawIdTunnelPrincipalResolver(undefined);
    setOpenClawIdClawOriginResolver(undefined);
    await current?.stop();
  };

  const pushMembership = async () => {
    if (!runtime) {
      return;
    }
    const owner = await getAuthority();
    const { seq, admitted } = await owner.admittedPeerKeys();
    runtime.pushMembership(seq, admitted);
    ownerExpiry.arm(await owner.nextOwnerExpiry());
  };

  // Ends the open sessions of owner devices whose certificates expired, then re-arms.
  const expireOwners = async () => {
    const peers = await (await getAuthority()).expiredOwnerPeers();
    if (peers.length === 0) {
      await pushMembership();
      return;
    }
    params.log.info(`openclaw-id: closing sessions of ${peers.length} expired owner device key(s)`);
    await applyEvents([{ type: "disconnect", peer_keys: peers }, { type: "publish_snapshot" }]);
  };

  // Accepted writes, and refusals that carry a security transition, have side effects.
  // An accepted removal also reports what it cut.
  const applyResult = async <T extends AuthorityAccepted | AuthorityRefusal>(
    result: T,
  ): Promise<T | (T & { removal: OpenClawIdRemovalSummary })> => {
    if (result.ok || (result.events?.length ?? 0) > 0) {
      const removal = await applyEvents(result.events ?? []);
      if (result.ok && removal) {
        return { ...result, removal };
      }
    }
    return result;
  };

  const reconcile = async () => {
    const config = params.getConfig();
    if (!config || !isOpenClawIdEnabled(config)) {
      await stopRuntime();
      status = { state: "off" };
      return;
    }
    const settings = resolveSettings(config, params.getStateDir());
    if ("missing" in settings) {
      await stopRuntime();
      status = { state: "unconfigured", missing: settings.missing };
      return;
    }
    if (runtime && sameSettings(runtime.settings, settings)) {
      return;
    }
    await stopRuntime();
    try {
      const { startTunnelRuntime } = await import("./tunnel-runtime.js");
      runtime = await startTunnelRuntime({
        settings,
        gatewayServer: params.getGatewayServer,
        membership: await (await getAuthority()).admittedPeerKeys(),
        log: params.log,
        onStatus: (tunnel) => {
          status = { state: "on", tunnel };
        },
        handleApi: handleTunnelApi,
      });
      status = { state: "on", tunnel: runtime.supervisor.status() };
      ownerExpiry.arm(await (await getAuthority()).nextOwnerExpiry());
      // Loaded before any member connects, so removal finds runs of closed connections.
      await getEffects();
      await publishTokenBindings();
      await startMailbox();
      await publicationRetry.start();
    } catch (error) {
      status = { state: "failed", reason: String((error as Error)?.message ?? error) };
      params.log.warn(`openclaw-id: could not start remote access: ${status.reason}`);
    }
  };

  // Publishes the descriptor and a fresh snapshot; best effort, never authority.
  const publish = async (enrollmentCode?: string): Promise<PublishOutcome | undefined> => {
    const config = params.getConfig();
    const record = (await getAuthority()).current();
    if (!config?.discoveryUrl || !config.relayUrl || !record?.authority) {
      return undefined;
    }
    const [{ publishClaw }, { createDiscoveryClient }, { loadGatewaySigner }] = await Promise.all([
      import("./publisher.js"),
      import("./discovery-client.js"),
      import("./gateway-key.js"),
    ]);
    const { signer } = await loadGatewaySigner(params.getStateDir());
    const outcome = await publishClaw({
      record,
      relayUrl: config.relayUrl,
      client: createDiscoveryClient({ baseUrl: config.discoveryUrl, signer }),
      signer,
      ...(enrollmentCode ? { enrollmentCode } : {}),
    });
    lastPublish = outcome;
    if (outcome.state === "published") {
      await (
        await getAuthority()
      ).recordDiscovery({
        owner_account_id: outcome.ownerAccountId,
        published_binding_seq: record.binding?.body.binding_seq ?? 0,
        published_snapshot_seq: outcome.snapshotSeq,
        published_snapshot_at: outcome.snapshotIssuedAt,
        published_revocations: outcome.revocationsPublished,
      });
      await startMailbox();
    } else if (outcome.state === "failed") {
      params.log.warn(`openclaw-id: Discovery publication failed (${outcome.code})`);
      // Registered before failing: keep the account, so a retry needs no enrollment code.
      if (outcome.ownerAccountId) {
        await (
          await getAuthority()
        ).recordDiscovery({
          owner_account_id: outcome.ownerAccountId,
          published_binding_seq: record.binding?.body.binding_seq ?? 0,
        });
        await startMailbox();
      }
    }
    return outcome;
  };

  // Performs the side effects of an accepted write in a fixed order: find the
  // removed keys' connections, withdraw tunnel access, cancel their runs, close
  // their sessions, revoke their tokens, then publish a new snapshot. Returns
  // what a removal cut, or undefined when the write removed no keys.
  const applyEvents = async (
    events: AuthorityEvent[],
  ): Promise<OpenClawIdRemovalSummary | undefined> => {
    const effects = await getEffects();
    const removed = [
      ...new Set(
        events.flatMap((event) =>
          event.type === "disconnect" || event.type === "invalidate_tokens" ? event.peer_keys : [],
        ),
      ),
    ];
    const connections = removed.length > 0 ? (effects?.captureConnections(removed) ?? []) : [];
    await pushMembership();
    let summary: OpenClawIdRemovalSummary | undefined;
    if (removed.length > 0) {
      const runsCancelled = events.some((event) => event.type === "cancel_runs")
        ? ((await effects?.cancelRuns?.(connections)) ?? 0)
        : 0;
      effects?.closeConnections(connections);
      const tokens = await (await getAuthority()).unbindPeers(removed);
      await effects?.revokeDeviceTokens(tokens);
      summary = {
        devices: removed.length,
        connectionsClosed: connections.length,
        runsCancelled,
      };
    }
    void notifyOwners(events).catch((error: unknown) =>
      params.log.warn(`openclaw-id: owner notices failed: ${String(error)}`),
    );
    if (events.some((event) => event.type === "publish_snapshot")) {
      void publicationRetry
        .request()
        .catch((error: unknown) =>
          params.log.warn(`openclaw-id: publication failed: ${String(error)}`),
        );
    }
    return summary;
  };

  // Members for the owner's People page: role, the name and email OpenClaw ID
  // reported when they joined by invite (display only), when the owner approved
  // them (seconds), and each device key's live activity read from this Gateway.
  const describeMembers = async (
    members: Record<string, { role: MemberRole; peer_keys: IrohEndpointKey[] }>,
    reports: StoredClaw["invite_reports"],
  ) => {
    const effects = await getEffects();
    const keys = Object.values(members).flatMap((member) => member.peer_keys);
    const activity = effects?.describeActivity?.(keys) ?? {};
    return Object.entries(members).map(([accountId, member]) => {
      const report = Object.values(reports ?? {}).find(
        (entry) => entry.account_id === accountId && entry.resolution === "approved",
      );
      return {
        accountId,
        role: member.role,
        peerKeys: member.peer_keys,
        email: report?.email ?? null,
        displayName: report?.display_name ?? null,
        approvedAt: report?.resolved_at ?? null,
        devices: member.peer_keys.map((peerKey) => ({
          peerKey,
          ...(activity[peerKey] ?? { connections: 0, lastSeenAt: null, runs: [] }),
        })),
      };
    });
  };

  // Mails owner notices through Discovery once the claw is registered there.
  const notifyOwners = async (events: AuthorityEvent[]) => {
    const { sendOwnerNotices } = await import("./owner-notices.js");
    await sendOwnerNotices({
      events,
      log: params.log,
      target: async () => {
        const config = params.getConfig();
        const record = (await getAuthority()).current();
        if (!config?.discoveryUrl || !record?.discovery.owner_account_id) {
          return undefined;
        }
        const [{ createDiscoveryClient }, { loadGatewaySigner }] = await Promise.all([
          import("./discovery-client.js"),
          import("./gateway-key.js"),
        ]);
        const { signer } = await loadGatewaySigner(params.getStateDir());
        return {
          clawId: record.claw_id,
          client: createDiscoveryClient({ baseUrl: config.discoveryUrl, signer }),
        };
      },
    });
  };

  // Publishes the device-token binding owner while remote access runs.
  const publishTokenBindings = async () => {
    const owner = await getAuthority();
    await owner.load();
    setDeviceTokenBindingOwner({
      lookup: (deviceId, role) => owner.tokenBinding(deviceId, role),
      record: (deviceId, role, peerKey) => owner.bindToken(deviceId, role, peerKey),
      reportMismatch: (event) =>
        params.log.warn(
          `openclaw-id: security: refused device token for ${event.deviceId} (${event.role}) presented from ${event.presentedFrom ?? "a non-tunnel connection"}; bound to ${event.boundTo ?? "no tunnel key"}`,
        ),
    });
    setOpenClawIdTunnelPrincipalResolver((peerKey) => owner.resolvePeer(peerKey));
    setOpenClawIdClawOriginResolver(() => clawOriginOfRecord(owner.current()));
  };

  // Reads the Discovery mailbox once the claw is registered there.
  const startMailbox = async () => {
    const config = params.getConfig();
    const record = await (await getAuthority()).load();
    if (
      mailbox ||
      !runtime ||
      !config?.discoveryUrl ||
      !record?.authority ||
      !record.discovery.owner_account_id
    ) {
      return;
    }
    const [{ startMailboxReader }, { createDiscoveryClient }, { loadGatewaySigner }] =
      await Promise.all([
        import("./mailbox-reader.js"),
        import("./discovery-client.js"),
        import("./gateway-key.js"),
      ]);
    const owner = await getAuthority();
    const { signer } = await loadGatewaySigner(params.getStateDir());
    const client = createDiscoveryClient({ baseUrl: config.discoveryUrl, signer });
    mailbox = startMailboxReader({
      clawId: record.claw_id,
      client,
      cursor: record.discovery.mailbox_cursor,
      sink: {
        submit: (statement) => owner.submit(statement, "mailbox"),
        redeem: (redemption, sender) => owner.redeem(redemption, sender),
        saveCursor: (cursor) => owner.recordDiscovery({ mailbox_cursor: cursor }),
      },
      onEffects: async (events) => {
        await applyEvents(events);
      },
      // A stale-seq root statement means the mirror is behind: republish, tell the sender.
      onRefused: async (message, refused) => {
        const { handleStaleSeqRefusal, isStaleSeqRefusal } = await import("./stale-seq.js");
        if (isStaleSeqRefusal(message, refused)) {
          await handleStaleSeqRefusal({
            message,
            currentSeq: owner.current()?.authority?.seq ?? 0,
            republish: () => publicationRetry.request(),
            target: async () => ({ clawId: record.claw_id, client }),
            log: params.log,
          });
        }
      },
      // Discovery is reachable again: publish anything still pending.
      onConnected: () =>
        void publicationRetry
          .resume()
          .catch((error: unknown) =>
            params.log.warn(`openclaw-id: publication failed: ${String(error)}`),
          ),
      log: params.log,
    });
  };

  // Serves the tunnel API (owner devices behind the loader) over the authority.
  const handleTunnelApi: TunnelApiHandler = async (req, res, peerKey) => {
    const { handleTunnelApiRequest } = await import("./tunnel-api.js");
    const owner = await getAuthority();
    await handleTunnelApiRequest(req, res, peerKey, {
      membership: (key) => owner.ownerView(key),
      submit: async (statement) => applyResult(await owner.submit(statement, "tunnel")),
      registerInvite: async (input) => {
        const result = await owner.registerInvite(input, "tunnel");
        if (result.ok) {
          await applyEvents(result.events);
        }
        return result;
      },
      seq: async () => (await owner.load())?.authority?.seq ?? 0,
    });
  };

  // K_srv of the running tunnel child, needed for the binding.
  const runningServerKey = (): IrohEndpointKey | undefined =>
    status.state === "on" && status.tunnel.state === "running"
      ? (status.tunnel.endpointKey as IrohEndpointKey)
      : undefined;

  /**
   * Asks Discovery which address the link code's account gets for a claw name
   * ("<name>-<account tag>.<loader domain>") and whether it is free. Local only.
   */
  const checkClawName = async (
    channel: Channel | undefined,
    request: ClawNameRequest,
  ): Promise<ClawNameCheck | AuthorityRefusal> => {
    if (channel !== "local_operator") {
      return refusal("not_local_operator", "Make reachable only works on this machine");
    }
    const config = params.getConfig();
    if (!isOpenClawIdEnabled(config) || !config?.loaderDomain || !config.discoveryUrl) {
      return refusal("unconfigured", "set gateway.openclawId.loaderDomain and discoveryUrl first");
    }
    if (!request.enrollmentCode || !request.name) {
      return refusal("malformed", "a link code and a claw name are required");
    }
    const [{ createDiscoveryClient }, { loadGatewaySigner }] = await Promise.all([
      import("./discovery-client.js"),
      import("./gateway-key.js"),
    ]);
    const { signer } = await loadGatewaySigner(params.getStateDir());
    const client = createDiscoveryClient({ baseUrl: config.discoveryUrl, signer });
    try {
      const checked = await client.checkClawName(request.enrollmentCode, request.name);
      // The binding is only usable on a single label under the loader domain.
      if (checked.hostname !== `${checked.name}-${checked.account_tag}.${config.loaderDomain}`) {
        return refusal("wrong_domain", `Discovery offered ${checked.hostname}`);
      }
      return {
        name: checked.name,
        accountTag: checked.account_tag,
        hostname: checked.hostname,
        available: checked.available,
      };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unavailable";
      return refusal(code, error instanceof Error ? error.message : String(error));
    }
  };

  // Owner-only link state (see the service's linkStatus).
  const ownerLinkStatus = async () => {
    if (!isOpenClawIdEnabled(params.getConfig())) {
      return { linked: false as const, publication: undefined };
    }
    const record = await (await getAuthority()).load();
    const state = record?.authority;
    const { isOwnerDeviceActive } =
      await import("../../../packages/openclaw-id-protocol/src/index.js");
    return {
      linked: Boolean(state),
      clawId: record?.claw_id,
      hostname: record?.hostname ?? undefined,
      rootPub: state?.anchor.root_pub,
      rootEpoch: state?.anchor.root_epoch,
      // Conflicting root rotations: remote root changes wait for owner-key regeneration.
      frozen: state?.frozen ?? false,
      seq: state?.seq,
      // Revoked, expired and earlier-epoch devices stay in the record but are no longer owners.
      ownerDevices: state
        ? Object.values(state.owner_devices)
            .filter((device) => isOwnerDeviceActive(state, device, Math.floor(Date.now() / 1000)))
            .map((device) => ({
              devicePub: device.cert.body.device_pub,
              label: device.cert.body.label,
              peerKeys: device.cert.body.peer_keys,
              // Public and signed: owner devices need it as the chain of their own changes.
              cert: device.cert,
            }))
        : [],
      members: state ? await describeMembers(state.members, record?.invite_reports) : [],
      invites: listInviteViews(record, Math.floor(Date.now() / 1000)),
      // After a restart, the last publication recorded with the claw stands in.
      publication:
        (lastPublish?.state === "failed"
          ? { ...lastPublish, retryAt: publicationRetry.nextRetryAt() }
          : lastPublish?.state === "published"
            ? { ...lastPublish, refreshAt: publicationRetry.nextRefreshAt() }
            : lastPublish) ??
        (record?.discovery.owner_account_id
          ? {
              state: "published" as const,
              ownerAccountId: record.discovery.owner_account_id,
              snapshotSeq: record.discovery.published_snapshot_seq,
              snapshotIssuedAt: record.discovery.published_snapshot_at ?? 0,
              revocationsPublished: record.discovery.published_revocations ?? 0,
            }
          : undefined),
    };
  };

  return {
    /** Connects removal side effects owned by the Gateway's connection and run owners (loaded on first use). */
    bindEffects(load: () => Promise<OpenClawIdEffects>): void {
      loadEffects = load;
    },
    /** Serves one tunnel API request from an admitted device (the ingress listener's handler). */
    serveTunnelApi: handleTunnelApi,
    /** Applies the current config: start, reconfigure or stop. */
    reconcileRuntimePolicy(): Promise<void> {
      queue = queue.then(reconcile, reconcile);
      return queue;
    },
    /** Current status; never touches the network. */
    status(): OpenClawIdStatus {
      return status;
    },

    /**
     * Whether a Gateway client may read and manage people: the direct-loopback
     * operator (who already holds the Gateway token and runs the root ceremonies),
     * or a tunnel client whose authenticated device key belongs to an owner device
     * that is active right now (current epoch, unexpired, unrevoked). Members and
     * every other client are refused; a scope alone is never enough.
     */
    async isOwnerClient(
      channel: Exclude<Channel, "mailbox"> | undefined,
      peerKey: string | undefined,
    ): Promise<boolean> {
      if (!isOpenClawIdEnabled(params.getConfig())) {
        return false;
      }
      if (channel === "local_operator") {
        return true;
      }
      if (channel !== "tunnel" || !peerKey) {
        return false;
      }
      return (await (await getAuthority()).resolvePeer(peerKey))?.kind === "owner";
    },

    /**
     * What any admitted client may read about the link: whether the claw is linked,
     * its address and pinned owner key (both public), and whether conflicting owner-key
     * changes froze it. No people, devices, activity
     * or publication account; those are owner-only (`linkStatus`).
     */
    async linkSummary() {
      if (!isOpenClawIdEnabled(params.getConfig())) {
        return { linked: false as const };
      }
      const record = await (await getAuthority()).load();
      const state = record?.authority;
      if (!record || !state) {
        return { linked: false as const };
      }
      return {
        linked: true as const,
        clawId: record.claw_id,
        hostname: record.hostname ?? undefined,
        rootPub: state.anchor.root_pub,
        rootEpoch: state.anchor.root_epoch,
        // Conflicting root rotations: the local operator resolves them by regenerating.
        frozen: state.frozen ?? false,
      };
    },

    /**
     * Owner-only link state for the People page and owner devices: identity, pinned
     * root, seq, active owner devices, members with their activity, invites and the
     * publication. Callers must check `isOwnerClient` first.
     */
    linkStatus: ownerLinkStatus,

    /**
     * Step 1 of "Make reachable": the claw identity, keys and the address for the
     * owner's chosen name, which the owner root will sign.
     */
    async prepareLink(
      channel: Channel | undefined,
      request: ClawNameRequest,
    ): Promise<LinkPreparation | AuthorityRefusal> {
      const checked = await checkClawName(channel, request);
      if ("ok" in checked) {
        return checked;
      }
      const kSrv = runningServerKey();
      if (!kSrv) {
        return refusal("tunnel_not_running", "the tunnel is not running yet");
      }
      if (!checked.available) {
        return refusal("name_taken", `${checked.hostname} is already taken`);
      }
      const { loadGatewaySigner } = await import("./gateway-key.js");
      const { pub } = await loadGatewaySigner(params.getStateDir());
      return await (
        await getAuthority()
      ).prepareLink({ kSrv, kGw: pub, hostname: checked.hostname });
    },

    checkClawName,

    /** Step 2: pin fp(R), admit owner device D1, store the binding, then publish. */
    async commitLink(
      channel: Channel | undefined,
      input: LinkCommit,
      enrollmentCode?: string,
    ): Promise<(AuthorityAccepted & { publication?: PublishOutcome }) | AuthorityRefusal> {
      const kSrv = runningServerKey();
      if (!kSrv) {
        return refusal("tunnel_not_running", "the tunnel is not running yet");
      }
      const { loadGatewaySigner } = await import("./gateway-key.js");
      const { pub: kGw }: { pub: Ed25519PublicKey } = await loadGatewaySigner(params.getStateDir());
      const result = await (await getAuthority()).commitLink(input, channel, { kSrv, kGw });
      if (!result.ok) {
        return result;
      }
      await pushMembership();
      const publication = await publish(enrollmentCode).catch((error: unknown) => {
        params.log.warn(`openclaw-id: publication failed: ${String(error)}`);
        return undefined;
      });
      await publicationRetry.adopt(publication);
      return { ...result, ...(publication ? { publication } : {}) };
    },

    /** Step 1 of owner-key regeneration: what the new root signs. Direct loopback only. */
    async prepareRegeneration(
      channel: Channel | undefined,
    ): Promise<OwnerKeyRegenerationPreparation | AuthorityRefusal> {
      return await (await getAuthority()).prepareRegeneration(channel);
    },

    /**
     * Step 2: pin the new root and enroll the regenerating device, then end every
     * old owner device's sessions and tokens, push the admission list to the
     * tunnel child and republish.
     */
    async regenerateOwnerKey(
      channel: Channel | undefined,
      input: OwnerKeyRegeneration,
    ): Promise<(AuthorityAccepted & { publication?: PublishOutcome }) | AuthorityRefusal> {
      const result = await (await getAuthority()).regenerateOwnerKey(input, channel);
      if (!result.ok) {
        return result;
      }
      await applyEvents(result.events.filter((event) => event.type !== "publish_snapshot"));
      const publication = await publish().catch((error: unknown) => {
        params.log.warn(`openclaw-id: publication failed: ${String(error)}`);
        return undefined;
      });
      await publicationRetry.adopt(publication);
      return { ...result, ...(publication ? { publication } : {}) };
    },

    /** Retries publication, for example with an enrollment code obtained after linking. */
    async publish(enrollmentCode?: string): Promise<PublishOutcome | undefined> {
      return await publish(enrollmentCode);
    },

    /** Applies an owner-signed statement sent directly by a client (never the mailbox). */
    async submitStatement(
      channel: Channel | undefined,
      input: unknown,
    ): Promise<(AuthorityAccepted & { removal?: OpenClawIdRemovalSummary }) | AuthorityRefusal> {
      if (!channel) {
        return refusal("not_direct", "membership changes come from an owner device on this claw");
      }
      return await applyResult(await (await getAuthority()).submit(input, channel));
    },

    /**
     * Registers an owner-signed InviteCap with its proof key. Only directly from an
     * owner device (tunnel or loopback); Discovery never sees the proof key.
     */
    async registerInvite(
      channel: Channel | undefined,
      input: { cap: unknown; proofKey: Uint8Array },
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      if (!channel) {
        return refusal("not_direct", "invites are registered from an owner device on this claw");
      }
      const result = await (await getAuthority()).registerInvite(input, channel);
      if (result.ok) {
        await applyEvents(result.events);
      }
      return result;
    },

    /** Stops everything this owner started. */
    stop(): Promise<void> {
      const stop = async () => {
        await stopRuntime();
        status = { state: "off" };
      };
      queue = queue.then(stop, stop);
      return queue;
    },
  };
}

export type OpenClawIdService = ReturnType<typeof createOpenClawIdService>;
