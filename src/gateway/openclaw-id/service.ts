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
  MemberRole,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import type {
  AuthorityAccepted,
  AuthorityRefusal,
  LinkCommit,
  LinkPreparation,
  DeviceTokenRef,
  OpenClawIdAuthority,
} from "./authority.js";
import { clawOriginOfRecord, setOpenClawIdClawOriginResolver } from "./claw-origin.js";
import type { OpenClawIdAccount, StoredClaw } from "./claw-store.js";
import { createOpenClawIdConnectionAccess } from "./connection-identity.js";
import { setDeviceTokenBindingOwner } from "./device-token-binding.js";
import type { TunnelApiHandler } from "./ingress-listener.js";
import { listInviteViews } from "./invites-view.js";
import type { OpenClawIdPeerActivity } from "./member-activity.js";
import { createOwnerExpiryTimer } from "./owner-expiry.js";
import { inactivityWindows, ownerLifecycleEvents } from "./owner-lifecycle.js";
import { createPublicationRetry } from "./publication-retry.js";
import type { PublishOutcome } from "./publisher.js";
import { signOutTunnelPeer } from "./remote-signout.js";
import { appliedConfigKey, resolveSettings, sameSettings } from "./service-settings.js";
import { createTokenBindingPublisher } from "./service-token-bindings.js";
import { setOpenClawIdTunnelPrincipalResolver } from "./tunnel-principal.js";
import type { TunnelRuntime } from "./tunnel-runtime.js";
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
  /** Revokes tunnel-issued tokens; returns those confirmed revoked (or already absent). */
  revokeDeviceTokens: <T extends { deviceId: string; role: string }>(
    tokens: readonly T[],
  ) => Promise<T[]>;
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
  let appliedKey: string | undefined;
  let runtime: TunnelRuntime | undefined;
  let authority: OpenClawIdAuthority | undefined;
  let loadingAuthority: Promise<OpenClawIdAuthority> | undefined;
  let lastPublish: PublishOutcome | undefined;
  let loadEffects: (() => Promise<OpenClawIdEffects>) | undefined;
  let effectsPromise: Promise<OpenClawIdEffects> | undefined;
  let mailbox: { stop(): void } | undefined;
  // Aborted when remote access stops: cancels Discovery requests in flight.
  let lifecycle = new AbortController();
  let stopAuthorityChanges: (() => void) | undefined;
  const peopleListeners = new Set<() => void>();
  const peopleChanged = () => notifyListeners(peopleListeners, undefined);
  // Reuse the single-deadline scheduler; expiry is derived from the committed record.
  const peopleExpiry = createOwnerExpiryTimer({
    onExpired: async () => {
      peopleChanged();
      armPeopleExpiry();
    },
  });
  const armPeopleExpiry = () => {
    if (isOpenClawIdEnabled(params.getConfig())) {
      peopleExpiry.arm(authority?.nextPeopleExpiry());
    }
  };
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

  // The persisted authority, created once and not yet observed for People changes.
  const createdAuthority = async (): Promise<OpenClawIdAuthority> => {
    if (!authority) {
      // Connection and run events can request the owner together during startup.
      loadingAuthority ??= params.createAuthority
        ? params.createAuthority()
        : import("./authority.js").then(({ createOpenClawIdAuthority }) =>
            createOpenClawIdAuthority(),
          );
      authority = await loadingAuthority;
    }
    return authority;
  };

  const getAuthority = async (): Promise<OpenClawIdAuthority> => {
    const current = await createdAuthority();
    if (!stopAuthorityChanges) {
      stopAuthorityChanges = current.onPeopleChanged(() => {
        peopleChanged();
        armPeopleExpiry();
      });
      const observing = stopAuthorityChanges;
      await current.load();
      if (observing === stopAuthorityChanges) {
        armPeopleExpiry();
      }
    }
    return current;
  };

  const stopRuntime = async () => {
    appliedKey = undefined;
    lifecycle.abort();
    lifecycle = new AbortController();
    const current = runtime;
    runtime = undefined;
    ownerExpiry.stop();
    peopleExpiry.stop();
    stopAuthorityChanges?.();
    stopAuthorityChanges = undefined;
    publicationRetry.stop();
    mailbox?.stop();
    mailbox = undefined;
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
    ownerExpiry.arm(await owner.nextOwnerExpiry(inactivityWindows(params.getConfig())));
  };

  // Drops keys unused past the inactivity windows and ends the open sessions of owner
  // devices whose certificates expired, then re-arms.
  const expireOwners = async () => {
    const events = await ownerLifecycleEvents(await getAuthority(), params.getConfig(), params.log);
    await (events ? applyEvents(events) : pushMembership());
  };

  // Accepted writes have side effects; an accepted removal also reports what it cut.
  const applyResult = async <T extends AuthorityAccepted | AuthorityRefusal>(
    result: T,
  ): Promise<T | (T & { removal: OpenClawIdRemovalSummary })> => {
    if (!result.ok) {
      return result;
    }
    const removal = await applyEvents(result.events);
    return removal ? { ...result, removal } : result;
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
    if (
      runtime &&
      sameSettings(runtime.settings, settings) &&
      appliedKey === appliedConfigKey(config)
    ) {
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
      appliedKey = appliedConfigKey(config);
      ownerExpiry.arm(
        await (await getAuthority()).nextOwnerExpiry(inactivityWindows(params.getConfig())),
      );
      // Loaded before any member connects, so removal finds runs of closed connections.
      await getEffects();
      await publishTokenBindings();
      await startMailbox();
      await revokeBoundTokens(await (await getAuthority()).orphanedTokens());
      // Publication runs beside the lifecycle, so a stalled Discovery cannot hold stop.
      void publicationRetry
        .start()
        .catch((error: unknown) =>
          params.log.warn(`openclaw-id: publication failed: ${String(error)}`),
        );
    } catch (error) {
      status = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
      params.log.warn(`openclaw-id: could not start remote access: ${status.reason}`);
    }
  };

  // Publishes the descriptor and a fresh snapshot; best effort, never authority.
  const publish = async (enrollmentCode?: string): Promise<PublishOutcome | undefined> => {
    // Captured on admission: a stop while this prepares cancels it, and a later start cannot adopt it.
    const signal = lifecycle.signal;
    const config = params.getConfig();
    if (!isOpenClawIdEnabled(config)) {
      return undefined;
    }
    const owner = await getAuthority();
    let record = owner.current();
    if (!config?.discoveryUrl || !config.relayUrl || !record?.authority) {
      return undefined;
    }
    const [{ publishClaw }, { createDiscoveryClient }, { loadGatewaySigner }] = await Promise.all([
      import("./publisher.js"),
      import("./discovery-client.js"),
      import("./gateway-key.js"),
    ]);
    const { signer } = await loadGatewaySigner(params.getStateDir());
    if (signal.aborted || !isOpenClawIdEnabled(params.getConfig())) {
      return undefined;
    }
    const client = createDiscoveryClient({ baseUrl: config.discoveryUrl, signer, signal });
    const { reconcileRegistration } = await import("./registration-recovery.js");
    const recoveryFailure = await reconcileRegistration(owner, client);
    // Recovery persisted the account before publication; consume the authority's current record.
    record = owner.current()!;
    const outcome =
      recoveryFailure ??
      (await publishClaw({
        record,
        relayUrl: config.relayUrl,
        client,
        signer,
        ...(enrollmentCode ? { enrollmentCode } : {}),
      }));
    lastPublish = outcome;
    if (outcome.state === "published") {
      await (
        await getAuthority()
      ).recordDiscovery({
        owner_account_id: outcome.ownerAccountId,
        published_binding_seq: record.binding?.body.binding_seq ?? 0,
        published_snapshot_seq: outcome.snapshotSeq,
        published_snapshot_at: outcome.snapshotIssuedAt,
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

  // Revokes tokens, then drops only the confirmed bindings: a token whose revocation
  // failed stays bound to its removed key, so no ingress accepts it, and is retried
  // at the next start.
  const revokeBoundTokens = async (tokens: DeviceTokenRef[]) => {
    const effects = await getEffects();
    if (!effects || tokens.length === 0) {
      return;
    }
    await (await getAuthority()).unbindTokens(await effects.revokeDeviceTokens(tokens));
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
      await revokeBoundTokens((await getAuthority()).tokensBoundTo(removed));
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
    approvedAt: StoredClaw["member_approved_at"],
  ) => {
    const effects = await getEffects();
    const profiles = await (await getAuthority()).memberProfiles(Object.keys(members));
    const keys = Object.values(members).flatMap((member) => member.peer_keys);
    const activity = effects?.describeActivity?.(keys) ?? {};
    return Object.entries(members).map(([accountId, member]) => {
      const profile = profiles[accountId];
      return {
        accountId,
        role: member.role,
        peerKeys: member.peer_keys,
        email: profile?.email ?? null,
        displayName: profile?.displayName ?? null,
        approvedAt: approvedAt?.[accountId] ?? null,
        devices: member.peer_keys.map((peerKey) => ({
          peerKey,
          ...(activity[peerKey] ?? { connections: 0, lastSeenAt: null, runs: [] }),
        })),
      };
    });
  };

  // Mails owner notices through Discovery once the claw is registered there.
  const notifyOwners = async (events: AuthorityEvent[]) => {
    // The admitting lifetime is captured before any await, so a stop during import ends the notice.
    const signal = lifecycle.signal;
    const { sendOwnerNotices } = await import("./owner-notices.js");
    if (signal.aborted) {
      return;
    }
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
        if (signal.aborted) {
          return undefined;
        }
        return {
          clawId: record.claw_id,
          client: createDiscoveryClient({ baseUrl: config.discoveryUrl, signer, signal }),
        };
      },
    });
  };

  const tokenBindings = createTokenBindingPublisher({
    authority: createdAuthority,
    log: params.log,
  });

  // Publishes the device-token binding owner and tunnel resolvers while remote access runs.
  const publishTokenBindings = async () => {
    const owner = await getAuthority();
    await owner.load();
    tokenBindings.publish(owner);
    // Every admitted tunnel connection restarts its key's inactivity clock.
    setOpenClawIdTunnelPrincipalResolver(async (peerKey) => {
      const principal = await owner.resolvePeer(peerKey);
      if (principal) {
        void owner
          .recordSeen(peerKey)
          .catch((error: unknown) =>
            params.log.warn(`openclaw-id: could not record device activity: ${String(error)}`),
          );
      }
      return principal;
    });
    setOpenClawIdClawOriginResolver(() => clawOriginOfRecord(owner.current()));
  };

  // Reads the Discovery mailbox once the claw is registered there.
  const startMailbox = async () => {
    const signal = lifecycle.signal;
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
    // A reader started for a stopped lifetime would also block the next lifetime's reader.
    if (signal.aborted || mailbox) {
      return;
    }
    const client = createDiscoveryClient({ baseUrl: config.discoveryUrl, signer, signal });
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
      signOut: async (key) =>
        signOutTunnelPeer(key, owner, await getEffects(), params.getStateDir()),
    });
  };

  // K_srv of the running tunnel child, needed for the binding.
  const runningServerKey = (): IrohEndpointKey | undefined => {
    if (status.state !== "on" || status.tunnel.state !== "running") {
      return undefined;
    }
    // SAFETY: the tunnel supervisor reports endpointKey as the formatted iroh:<hex> key.
    return status.tunnel.endpointKey as IrohEndpointKey;
  };

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
    const signal = lifecycle.signal;
    const [{ createDiscoveryClient }, { loadGatewaySigner }] = await Promise.all([
      import("./discovery-client.js"),
      import("./gateway-key.js"),
    ]);
    const { signer } = await loadGatewaySigner(params.getStateDir());
    if (signal.aborted) {
      return refusal("off", "remote access was turned off");
    }
    const client = createDiscoveryClient({ baseUrl: config.discoveryUrl, signer, signal });
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
      // SAFETY: code is optional and falls back to "unavailable" when absent.
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
    const { describeOwnerDevices } = await import("./owner-devices-view.js");
    return {
      linked: Boolean(state),
      clawId: record?.claw_id,
      hostname: record?.hostname ?? undefined,
      rootPub: state?.anchor.root_pub,
      seq: state?.seq,
      ownerDevices: state ? describeOwnerDevices(state, Math.floor(Date.now() / 1000)) : [],
      members: state ? await describeMembers(state.members, record?.member_approved_at) : [],
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
            }
          : undefined),
    };
  };

  const connectionAccess = createOpenClawIdConnectionAccess({
    enabled: () => isOpenClawIdEnabled(params.getConfig()),
    getAuthority,
  });

  return {
    /** Subscribes to committed People changes and time-derived invite/owner expiry. */
    onPeopleChanged(listener: () => void): () => void {
      return registerListener(peopleListeners, listener);
    },
    ...connectionAccess,
    /** Records display claims produced by the Gateway's verified sign-in flow, never RPC params. */
    async recordVerifiedAccount(account: OpenClawIdAccount): Promise<void> {
      await (await getAuthority()).recordVerifiedAccount(account);
    },
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
     * What any admitted client may read about the link: whether the claw is linked,
     * its address and pinned owner key (both public). No people, devices, activity
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
      };
    },

    /**
     * Owner-only link state for the People page and owner devices: identity, pinned
     * root, seq, active owner devices, members with their activity, invites and the
     * publication. Callers must check `isOwnerClient` first.
     */
    linkStatus: ownerLinkStatus,

    /** Public signed binding for an owner-device SAS handoff; callers must enforce owner access. */
    async ownerBinding() {
      return (await getAuthority()).current()?.binding ?? null;
    },

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
      const publication = await publicationRetry
        .publishDirect(() => publish(enrollmentCode))
        .catch((error: unknown) => {
          params.log.warn(`openclaw-id: publication failed: ${String(error)}`);
          return undefined;
        });
      await publicationRetry.adopt(publication);
      return { ...result, ...(publication ? { publication } : {}) };
    },

    /** Retries publication, for example with an enrollment code obtained after linking. */
    async publish(enrollmentCode?: string): Promise<PublishOutcome | undefined> {
      return await publicationRetry.publishDirect(() => publish(enrollmentCode));
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

    /** Reads the saved device-token bindings; device-token checks wait for it. */
    loadTokenBindings(): Promise<void> {
      return tokenBindings.loadAtStart();
    },

    /** Stops everything this owner started. */
    stop(): Promise<void> {
      const stop = async () => {
        await stopRuntime();
        // Tokens issued over the tunnel stay bound to their device key after the switch
        // turns off; enforcement ends only with this Gateway lifetime.
        setDeviceTokenBindingOwner(undefined);
        status = { state: "off" };
      };
      queue = queue.then(stop, stop);
      return queue;
    },
  };
}

export type OpenClawIdService = ReturnType<typeof createOpenClawIdService>;
