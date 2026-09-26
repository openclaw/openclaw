/** Transport-independent CLI node-host runtime shared by Gateway and app workers. */
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig } from "../config/config.js";
import { NODE_CLAUDE_SKILLS_MESSAGE_BYTES } from "../infra/node-claude-skill-protocol.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
} from "../infra/node-commands.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { ensureTerminalUploadCleanup } from "../infra/terminal-file-upload.js";
import { logDebug } from "../logger.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { BoundedBuffer } from "../shared/bounded-buffer.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { createNodeInvokeResponder, type NodeHostClient } from "./client.js";
import { resolveNodeDesktopHostConfig } from "./desktop-stream-command.js";
import { requestsClaudeNodeSkillRuntime } from "./invoke-agent-cli-claude-params.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import { buildNodeEventParams } from "./node-event-params.js";
import {
  dispatchNodeInvokeInput,
  registerNodeInvokeInputHandler,
  type NodeInvokeInputTarget,
} from "./node-invoke-input.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { resolveNodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import { NodeWorkerContainerContextMismatchError } from "./node-worker-container-lifecycle.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import {
  ensureNodeHostPluginRegistry,
  hasRegisteredNodeHostCommandActiveWork,
  isRegisteredNodeHostCommandDuplex,
  listRegisteredNodeHostCapsAndCommands,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
} from "./plugin-node-host.js";
import {
  buildNodeHostManifest,
  createNodeHostInventory,
  sameNodeHostManifest,
  type NodeHostManifest,
  type NodeHostInventory,
} from "./runtime-manifest.js";
import { resolveExecutableTrustPathFromEnv, SkillBinsCache } from "./runtime-skill-bins.js";
import { createNodeHostUpdatePause } from "./runtime-update-pause.js";
import { scanNodeHostedSkills } from "./skills.js";
export type { NodeHostInventory } from "./runtime-manifest.js";

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const WORKER_INITIALIZATION_RETRY_MS = 5_000;

type PreparedNodeHostRuntime = {
  manifest: NodeHostManifest;
  workerHostingEnabled: boolean;
  preparedWorkspacesEnabled: boolean;
  restrictedSurface?: true;
  workerHostingDisabledReason?: string;
  initialInventory: NodeHostInventory;
  start(params: {
    client: NodeHostClient;
    onInventoryChanged?: (inventory: NodeHostInventory) => void;
    onManifestChanged?: (manifest: NodeHostManifest) => void;
    onRunnerCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
    onWorkerHostingDisabled?: (reason: string) => void;
  }): ActiveNodeHostRuntime;
};

type ActiveNodeHostRuntime = {
  invoke(frame: NodeInvokeRequestPayload): Promise<void>;
  handleInput(invokeId: string, seq: number, payloadJSON: string): void;
  cancel(invokeId: string): void;
  cancelAll(): void;
  tryPauseForUpdate(): Promise<boolean>;
  resumeAfterUpdate(): void;
  updateGatewayConnection(connection?: {
    url: string;
    tlsFingerprint?: string;
    cloudflareAccess?: CloudflareAccessCredentials;
  }): void;
  close(): Promise<void>;
};

type ActiveNodeInvoke = {
  controller: AbortController;
  framedFailure?: Error;
  input?: NodeInvokeInputTarget;
};

const MAX_PENDING_INVOKE_INPUT_BYTES = 64 * 1024;

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

export async function prepareNodeHostRuntime(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** The embedded app worker never advertises native agent runs. */
  enableAgentRuns?: boolean;
  /** The embedded app worker never advertises full worker session hosting. */
  enableWorkerRuns?: boolean;
  /** Process-scoped worker hosting for environment-managed disposable nodes. */
  forceWorkerRuns?: boolean;
  /** Disposable cloud nodes expose computer control only through the private carrier. */
  ephemeral?: boolean;
  /** Embedded workers may still host long-lived plugin commands over the app-owned socket. */
  enableDuplexPluginCommands?: boolean;
  installedAppsSharingEnabled?: boolean;
  desktopSharingEnabled?: boolean;
  commands?: readonly string[];
  platform?: NodeJS.Platform;
}): Promise<PreparedNodeHostRuntime> {
  const commandAllowlist = params?.commands === undefined ? undefined : new Set(params.commands);
  if (!commandAllowlist) {
    void ensureTerminalUploadCleanup();
  }
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  await ensureNodeHostPluginRegistry({ config, env, commandAllowlist });
  const pathEnv = ensureNodePathEnv();
  env.PATH = pathEnv;
  const duplexEnabled =
    params?.enableAgentRuns === true || params?.enableDuplexPluginCommands === true;
  const platform = params?.platform ?? process.platform;
  const installedAppsSharingEnabled =
    platform === "darwin" && params?.installedAppsSharingEnabled === true;
  const desktopHostConfig = resolveNodeDesktopHostConfig({
    config: config.desktop?.host,
    desktopSharingEnabled: params?.desktopSharingEnabled,
    platform,
    ephemeral: params?.ephemeral,
  });
  const availabilityContext = { config, env };
  const resolvePluginNodeHost = () =>
    listRegisteredNodeHostCapsAndCommands(availabilityContext, {
      includeDuplex: duplexEnabled,
      ...(commandAllowlist ? { commandAllowlist } : {}),
    });
  const pluginNodeHost = resolvePluginNodeHost();
  // Opt-in and binary resolution are node-local enforcement points. A Gateway
  // cannot advertise or enable this command on the host's behalf.
  const claudePath =
    params?.enableAgentRuns === true && config.nodeHost?.agentRuns?.claude?.enabled === true
      ? resolveExecutableTrustPathFromEnv("claude", pathEnv)
      : null;
  let workerRunsEnabled =
    !commandAllowlist &&
    params?.enableWorkerRuns === true &&
    (params.forceWorkerRuns === true || config.nodeHost?.workerRuns?.enabled === true);
  const workspaceOptions = { env, ephemeral: params?.ephemeral };
  let preparedContainerWorkspace: NodeWorkerWorkspaceRuntime | undefined;
  let preparedContainerSupervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;
  let preparedContainerCapacity: NodeWorkerCapacitySnapshot | undefined;
  let preparedContainerInitialized = false;
  let workerCleanupIncomplete = false;
  let publishContainerCapacity: ((capacity: NodeWorkerCapacitySnapshot) => void) | undefined;
  let workerHostingDisabledReason: string | undefined;
  const disablePreparedContainerHosting = async (error: unknown) => {
    let failure = error;
    workerCleanupIncomplete ||= error instanceof NodeWorkerContainerContextMismatchError;
    try {
      await preparedContainerSupervisor?.close();
    } catch (closeError) {
      workerCleanupIncomplete = true;
      if (closeError !== error) {
        failure = new Error(`${String(error)}; supervisor cleanup failed: ${String(closeError)}`);
      }
    }
    workerRunsEnabled = false;
    preparedContainerWorkspace = undefined;
    preparedContainerSupervisor = undefined;
    preparedContainerCapacity = undefined;
    workerHostingDisabledReason = failure instanceof Error ? failure.message : String(failure);
  };
  if (workerRunsEnabled && config.nodeHost?.workerRuns?.isolation === "container") {
    try {
      if (platform === "win32") {
        throw new Error(
          'Container-isolated node workers are unsupported on Windows because native paths cannot be mounted at their container paths; run the node host on Linux or macOS, or set isolation to "none".',
        );
      }
      const containerEngine = await resolveNodeWorkerContainerEngine({ env });
      preparedContainerWorkspace = new NodeWorkerWorkspaceRuntime(workspaceOptions);
      preparedContainerSupervisor = createNodeWorkerSupervisor({
        env,
        capacity: config.nodeHost?.workerRuns?.capacity,
        nativeInferenceConfig: config.nodeHost?.workerRuns?.nativeInferenceConfig,
        workspace: preparedContainerWorkspace,
        containerEngine,
        ...(config.nodeHost?.workerRuns?.containerImage
          ? { containerImage: config.nodeHost.workerRuns.containerImage }
          : {}),
        onCapacityChanged: (capacity) => {
          preparedContainerCapacity = capacity;
          publishContainerCapacity?.(capacity);
        },
      });
      try {
        // Container ownership and orphan cleanup must precede positive capacity publication.
        await preparedContainerSupervisor.initialize();
        preparedContainerInitialized = true;
      } catch (error) {
        if (error instanceof NodeWorkerContainerContextMismatchError) {
          await disablePreparedContainerHosting(error);
        } else {
          logDebug(`node-host: worker capacity reconciliation failed: ${String(error)}`);
        }
      }
    } catch (error) {
      await disablePreparedContainerHosting(error);
    }
  }
  const skills =
    commandAllowlist || config.nodeHost?.skills?.enabled === false ? null : scanNodeHostedSkills();
  const buildManifest = (pluginManifest: typeof pluginNodeHost) =>
    buildNodeHostManifest({
      pluginManifest,
      commandAllowlist,
      claudeEnabled: Boolean(claudePath),
      installedAppsSharingEnabled,
      desktopStreamingEnabled: desktopHostConfig.enabled,
      ephemeral: params?.ephemeral === true,
      pathEnv,
    });
  const manifest = buildManifest(pluginNodeHost);
  if (commandAllowlist && manifest.commands.length === 0) {
    const requested = [...commandAllowlist].toSorted().join(", ") || "(empty allowlist)";
    throw new Error(
      `Node command allowlist retained no available commands. Unknown or unavailable ids: ${requested}. Check --commands and enable the plugin that provides each command.`,
    );
  }
  const initialInventory = createNodeHostInventory(skills, pluginNodeHost.nodePluginTools);

  return {
    manifest,
    workerHostingEnabled: workerRunsEnabled,
    preparedWorkspacesEnabled: workerRunsEnabled && params?.ephemeral === true,
    ...(commandAllowlist ? { restrictedSurface: true as const } : {}),
    ...(workerHostingDisabledReason ? { workerHostingDisabledReason } : {}),
    initialInventory,
    start({
      client,
      onInventoryChanged,
      onManifestChanged,
      onRunnerCapacityChanged,
      onWorkerHostingDisabled,
    }) {
      const mcpAbort = new AbortController();
      let closing = false;
      let inFlightInvokes = 0;
      let connectionGeneration = 0;
      let closePromise: Promise<void> | undefined;
      let supervisorClose: Promise<void> | undefined;
      let mcpClose: Promise<void> | undefined;
      let initializationRetry: ReturnType<typeof setTimeout> | undefined;
      const workerWorkspace =
        preparedContainerWorkspace ??
        (workerRunsEnabled ? new NodeWorkerWorkspaceRuntime(workspaceOptions) : undefined);
      const workerBundleInstaller = workerRunsEnabled
        ? new NodeWorkerBundleInstaller({ env })
        : undefined;
      let workerSupervisor =
        preparedContainerSupervisor ??
        (workerRunsEnabled
          ? createNodeWorkerSupervisor({
              env,
              capacity: config.nodeHost?.workerRuns?.capacity,
              nativeInferenceConfig: config.nodeHost?.workerRuns?.nativeInferenceConfig,
              onCapacityChanged: onRunnerCapacityChanged,
              workspace: workerWorkspace,
            })
          : undefined);
      if (preparedContainerSupervisor) {
        publishContainerCapacity = onRunnerCapacityChanged;
        if (preparedContainerCapacity) {
          onRunnerCapacityChanged?.(preparedContainerCapacity);
        }
      }
      const initializeWorkerSupervisor = () => {
        const supervisor = workerSupervisor;
        if (!supervisor || closing) {
          return;
        }
        void supervisor.initialize().catch(async (error: unknown) => {
          logDebug(`node-host: worker capacity reconciliation failed: ${String(error)}`);
          if (closing || workerSupervisor !== supervisor) {
            return;
          }
          if (error instanceof NodeWorkerContainerContextMismatchError) {
            // Closing this supervisor cannot retire claims on a different daemon.
            workerCleanupIncomplete = true;
            workerSupervisor = undefined;
            onWorkerHostingDisabled?.(error.message);
            await supervisor.close().catch((closeError: unknown) => {
              logDebug(`node-host: worker supervisor cleanup failed: ${String(closeError)}`);
            });
            return;
          }
          initializationRetry = setTimeout(() => {
            initializationRetry = undefined;
            initializeWorkerSupervisor();
          }, WORKER_INITIALIZATION_RETRY_MS);
          initializationRetry.unref?.();
        });
      };
      if (workerSupervisor && !preparedContainerInitialized) {
        initializeWorkerSupervisor();
      }
      let skillBins = new SkillBinsCache(client, pathEnv);
      const activeInvokes = new Map<string, ActiveNodeInvoke>();
      let pluginDisconnectCleanup: Promise<void> = Promise.resolve();
      let pendingPluginDisconnectCleanups = 0;
      let pluginDisconnectCleanupFailed = false;
      const pluginCommandContext: OpenClawPluginNodeHostCommandContext = {
        sendNodeEvent: async (event, payload) =>
          await client.request("node.event", buildNodeEventParams(event, payload)),
        ...(workerWorkspace
          ? {
              acquireManagedWorkspaceAsync: (request) =>
                workerWorkspace.acquireManagedWorkspaceAsync(request),
              acquireManagedWorkspace: (request) =>
                workerWorkspace.acquireManagedWorkspace(request),
            }
          : {}),
      };
      let currentPluginNodeHost = pluginNodeHost;
      let currentManifest = manifest;
      let gatewayConnection:
        | {
            url: string;
            tlsFingerprint?: string;
            cloudflareAccess?: CloudflareAccessCredentials;
          }
        | undefined;
      let manager: NodeHostMcpManager | undefined;
      let mcpStartupComplete = Boolean(commandAllowlist);
      const publishInventory = () =>
        onInventoryChanged?.(
          createNodeHostInventory(
            skills,
            currentPluginNodeHost.nodePluginTools,
            manager?.descriptors,
          ),
        );
      const startup = commandAllowlist
        ? Promise.resolve(undefined)
        : startNodeHostMcpManager(config.nodeHost?.mcp?.servers, {
            signal: mcpAbort.signal,
            onDescriptorsChanged: () => {
              if (!closing && manager) {
                publishInventory();
              }
            },
          }).then((resolved) => {
            manager = resolved;
            mcpStartupComplete = true;
            if (!closing) {
              publishInventory();
            }
            return resolved;
          });
      const refreshAvailability = () => {
        if (closing) {
          return;
        }
        const nextPluginNodeHost = resolvePluginNodeHost();
        const nextManifest = buildManifest(nextPluginNodeHost);
        currentPluginNodeHost = nextPluginNodeHost;
        if (!sameNodeHostManifest(currentManifest, nextManifest)) {
          currentManifest = nextManifest;
          onManifestChanged?.(nextManifest);
        }
        publishInventory();
      };
      const stopAvailabilityWatch = onManifestChanged
        ? watchRegisteredNodeHostCommandAvailability(
            availabilityContext,
            refreshAvailability,
            commandAllowlist,
          )
        : async () => {};
      // The watcher cannot replay a socket change between preparation and
      // registration. Resolve once after attachment to close that race.
      if (onManifestChanged) {
        refreshAvailability();
      }
      const updatePause = createNodeHostUpdatePause({
        hasLocalActiveWork: () =>
          closing ||
          !mcpStartupComplete ||
          inFlightInvokes > 0 ||
          pendingPluginDisconnectCleanups > 0 ||
          pluginDisconnectCleanupFailed ||
          hasRegisteredNodeHostCommandActiveWork() ||
          workerCleanupIncomplete,
        hasWorkerActiveWork: () => workerSupervisor?.hasActiveWork(),
      });
      return {
        async invoke(frame) {
          if (updatePause.isPaused) {
            await createNodeInvokeResponder(client, frame).error(
              "UNAVAILABLE",
              "node host is updating; retry shortly",
            );
            return;
          }
          // Admission precedes the first await; disconnects and duplicate IDs do
          // not release update ownership before the original command settles.
          inFlightInvokes += 1;
          try {
            const generation = connectionGeneration;
            try {
              await pluginDisconnectCleanup;
            } catch {
              if (!closing && generation === connectionGeneration) {
                await client
                  .request("node.invoke.result", {
                    id: frame.id,
                    nodeId: frame.nodeId,
                    ok: false,
                    error: {
                      code: "UNAVAILABLE",
                      message: "Node plugin cleanup failed. Reconnect the node to retry cleanup.",
                    },
                  })
                  .catch(() => {});
              }
              return;
            }
            if (closing || generation !== connectionGeneration) {
              return;
            }
            // Enforce the declaration locally too: a paired Gateway cannot widen
            // an operator-restricted surface by sending a hidden command directly.
            if (commandAllowlist && !currentManifest.commands.includes(frame.command)) {
              await createNodeInvokeResponder(client, frame).error(
                "UNAVAILABLE",
                "command not advertised by this node",
              );
              return;
            }
            const claudeSkills =
              frame.command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND &&
              requestsClaudeNodeSkillRuntime(frame.paramsJSON);
            const duplexCommand =
              duplexEnabled && (claudeSkills || isRegisteredNodeHostCommandDuplex(frame.command));
            const progressEnabled = duplexCommand || frame.command === NODE_DESKTOP_STREAM_COMMAND;
            const controller = new AbortController();
            // Every command must remain cancellable after dispatch; only duplex
            // commands own ordered input and its pre-spawn buffer.
            const input: NodeInvokeInputTarget | undefined = duplexCommand
              ? {
                  nextInputSeq: 0,
                  pendingInput: new BoundedBuffer<string>(
                    MAX_PENDING_INVOKE_INPUT_BYTES,
                    {
                      mode: "fail-closed",
                      onOverflow: () =>
                        controller.abort(
                          new Error("terminal input exceeded the 64 KiB pre-spawn buffer"),
                        ),
                    },
                    (payload) => Buffer.byteLength(payload, "utf8"),
                  ),
                  inputFailed: false,
                }
              : undefined;
            const active: ActiveNodeInvoke = { controller, ...(input ? { input } : {}) };
            // Redelivered IDs must not orphan the original command's process or
            // let its cleanup unregister the replacement invocation.
            activeInvokes.get(frame.id)?.controller.abort();
            activeInvokes.set(frame.id, active);
            const progress = progressEnabled
              ? createNodeInvokeProgressWriter({
                  client,
                  frame,
                  idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
                  onError: () => controller.abort(),
                })
              : undefined;
            if (duplexCommand) {
              progress?.startHeartbeats();
            }
            const framedIo =
              input && progress
                ? createNodeDuplexEndpoint({
                    ...(claudeSkills ? { maxMessageBytes: NODE_CLAUDE_SKILLS_MESSAGE_BYTES } : {}),
                    sendFrame: async (payload) => await progress.write(JSON.stringify(payload)),
                    onError: (error) => {
                      active.framedFailure = error;
                      controller.abort(error);
                    },
                  })
                : undefined;
            if (framedIo) {
              controller.signal.addEventListener("abort", () => framedIo.close(), { once: true });
            }
            let framedInputRegistered = false;
            const pluginCommandIo: OpenClawPluginNodeHostCommandIo | undefined =
              input && progress && framedIo
                ? {
                    signal: controller.signal,
                    emitChunk: async (chunk) => await progress.write(chunk),
                    onInput: (callback) => {
                      if (activeInvokes.get(frame.id) === active) {
                        registerNodeInvokeInputHandler(input, callback);
                      }
                    },
                    frames: {
                      send: async (message) => await framedIo.send(message),
                      onMessage: (callback) => {
                        const unsubscribe = framedIo.onMessage(callback);
                        if (!framedInputRegistered) {
                          framedInputRegistered = true;
                          registerNodeInvokeInputHandler(input, (payloadJSON) => {
                            try {
                              framedIo.receive(payloadJSON);
                            } catch (error) {
                              controller.abort(error);
                            }
                          });
                          void framedIo.sendReady().catch(controller.abort.bind(controller));
                        }
                        return unsubscribe;
                      },
                    },
                  }
                : undefined;
            try {
              await handleInvoke(frame, client, skillBins, manager, {
                ...(claudePath ? { claudePath } : {}),
                signal: controller.signal,
                pluginCommandIo,
                flushPluginCommandIo: framedIo?.drain,
                canReportAbortedFailure: (error) =>
                  controller.signal.aborted &&
                  error === active.framedFailure &&
                  error === controller.signal.reason &&
                  activeInvokes.get(frame.id) === active,
                ...(gatewayConnection?.url ? { gatewayUrl: gatewayConnection.url } : {}),
                ...(gatewayConnection?.tlsFingerprint
                  ? { gatewayTlsFingerprint: gatewayConnection.tlsFingerprint }
                  : {}),
                ...(gatewayConnection?.cloudflareAccess
                  ? { gatewayCloudflareAccess: gatewayConnection.cloudflareAccess }
                  : {}),
                desktopHostConfig,
                ...(progress ? { emitProgress: (text) => progress.write(text) } : {}),
                installedAppsSharingEnabled,
                installedAppsPlatform: platform,
                pluginCommandContext,
                ...(params?.ephemeral === true && !commandAllowlist
                  ? { workerComputer: { capabilities: () => resolvePluginNodeHost().computerUse } }
                  : {}),
                ...(workerBundleInstaller ? { workerBundleInstaller } : {}),
                ...(workerSupervisor ? { workerSupervisor } : {}),
                ...(workerWorkspace ? { workerWorkspace } : {}),
              });
            } finally {
              framedIo?.close();
              progress?.stop();
              await progress?.flush();
              if (activeInvokes.get(frame.id) === active) {
                activeInvokes.delete(frame.id);
              }
            }
          } finally {
            inFlightInvokes -= 1;
          }
        },
        handleInput(invokeId, seq, payloadJSON) {
          const input = activeInvokes.get(invokeId)?.input;
          if (!dispatchNodeInvokeInput(input, seq, payloadJSON)) {
            logDebug(`node-host: dropped inactive or duplicate input for invoke ${invokeId}`);
          }
        },
        cancel(invokeId) {
          activeInvokes.get(invokeId)?.controller.abort();
        },
        cancelAll() {
          connectionGeneration += 1;
          // Retired refreshes may still finish; their cache must never serve the next connection.
          skillBins = new SkillBinsCache(client, pathEnv);
          // Close can reenter from an abort listener and must see this cleanup barrier.
          pendingPluginDisconnectCleanups += 1;
          const cleanup = pluginDisconnectCleanup
            .catch(() => {})
            .then(async () => await notifyRegisteredNodeHostCommandDisconnect())
            .finally(() => {
              pendingPluginDisconnectCleanups -= 1;
            });
          pluginDisconnectCleanup = cleanup;
          // Logging observes the failure; invocation and shutdown retain the rejected result.
          void cleanup.then(
            () => {
              if (pluginDisconnectCleanup === cleanup) {
                pluginDisconnectCleanupFailed = false;
              }
            },
            (error: unknown) => {
              if (pluginDisconnectCleanup === cleanup) {
                pluginDisconnectCleanupFailed = true;
              }
              logDebug(`node-host: plugin disconnect cleanup failed: ${String(error)}`);
            },
          );
          for (const active of activeInvokes.values()) {
            active.controller.abort();
          }
          activeInvokes.clear();
        },
        tryPauseForUpdate: updatePause.tryPauseForUpdate,
        resumeAfterUpdate: updatePause.resumeAfterUpdate,
        updateGatewayConnection(connection) {
          gatewayConnection = connection;
        },
        close() {
          if (closePromise) {
            return closePromise;
          }
          const wasClosing = closing;
          closing = true;
          // Install the shared completion before abort listeners or cleanup can reenter close.
          const completion = createDeferredCore();
          closePromise = completion.promise;
          const closeOwners = async () => {
            if (!wasClosing) {
              if (initializationRetry) {
                clearTimeout(initializationRetry);
                initializationRetry = undefined;
              }
              this.cancelAll();
            } else if (pluginDisconnectCleanupFailed) {
              this.cancelAll();
            }
            const watcherClose = stopAvailabilityWatch();
            // Startup observes this signal before either independent owner is joined.
            mcpAbort.abort();
            const disconnectClose = pluginDisconnectCleanup;
            supervisorClose ??= Promise.resolve()
              .then(() => workerSupervisor?.close())
              .catch((error: unknown) => {
                // The supervisor retains failed retirement records and an open journal for retry.
                supervisorClose = undefined;
                throw error;
              });
            // MCP close is terminal: another call after failure can return an empty success.
            mcpClose ??= startup.then((resolved) => resolved?.close());
            const results = await Promise.allSettled([
              watcherClose,
              disconnectClose,
              supervisorClose,
              mcpClose,
            ]);
            const errors = [
              ...new Set(
                results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
              ),
            ];
            if (errors.length === 1) {
              throw errors[0];
            }
            if (errors.length > 1) {
              throw new AggregateError(errors, "node-host runtime close failed");
            }
          };
          void closeOwners().then(completion.resolve, (error: unknown) => {
            closePromise = undefined;
            completion.reject(error);
          });
          return completion.promise;
        },
      };
    },
  };
}
