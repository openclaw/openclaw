import {
  ed25519SignerFromSeed,
  parseNodeJoinLink,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { runNodeDaemonInstall } from "../cli/node-cli/daemon.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { defaultRuntime } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { normalizeNodeHostCommands } from "./config-shared.js";
import { loadNodeHostConfig } from "./config.js";
import { enrollNode } from "./openclaw-id-enrollment.js";
import { parseNodeDiscoveryOrigin } from "./openclaw-id-target.js";
import { loadNodeTunnelKey } from "./openclaw-id-transport.js";
import { runNodeHost } from "./runner.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { ensureNodeHostStateReady } from "./startup-state-readiness.js";

export type NodeJoinOptions = {
  service?: boolean;
  discoveryUrl?: string;
  displayName?: string;
  commands?: string[];
  allCommands?: boolean;
};

/** Enrollment does not alter the saved target until owner admission and pin checks succeed. */
export async function runNodeJoin(linkText: string, opts: NodeJoinOptions): Promise<void> {
  const link = parseNodeJoinLink(linkText);
  if (!link) {
    throw new Error("Invalid OpenClaw ID node join link; copy a fresh link from the owner.");
  }
  if (opts.commands !== undefined && opts.allCommands) {
    throw new Error("--all-commands cannot be combined with --commands");
  }
  if (process.platform === "win32") {
    throw new Error("Labs OpenClaw ID node transport currently requires Unix sockets");
  }
  const saved = await loadNodeHostConfig();
  const discovery = opts.discoveryUrl ?? saved?.gateway?.openclawId?.discoveryUrl;
  if (!discovery) {
    throw new Error(
      "Discovery API origin is not configured; pass --discovery-url <https-origin> from the claw owner.",
    );
  }
  const discoveryUrl = parseNodeDiscoveryOrigin(discovery);
  const cfg = await captureRuntimeConfigAsyncReader()();
  if (cfg.nodeHost?.workerRuns?.isolation === "container") {
    throw new Error("Labs OpenClaw ID node transport supports native-process workers only");
  }
  const commands =
    opts.commands !== undefined
      ? normalizeNodeHostCommands(opts.commands)
      : opts.allCommands
        ? undefined
        : saved?.commands;
  const fallbackDisplayName = await getMachineDisplayName();
  const displayName = opts.displayName?.trim() || saved?.displayName || fallbackDisplayName;
  await ensureNodeHostStateReady();
  // Use the real prepared manifest, not a guessed command list. Passing it to the runner
  // keeps the first connection identical to the surface the owner compared and approved.
  const preparedRuntime = await prepareNodeHostRuntime({
    config: cfg,
    env: process.env,
    enableAgentRuns: true,
    receivesLocalMcpPolicy: true,
    installedAppsSharingEnabled: saved?.installedAppsSharing,
    commands,
  });
  const key = loadNodeTunnelKey();
  const signer = await ed25519SignerFromSeed(key).finally(() => key.fill(0));
  const target = await enrollNode({
    link,
    discoveryUrl,
    signer,
    previousPin: saved?.gateway?.openclawId?.pin,
    description: {
      display_name: displayName,
      platform: process.platform,
      commands: preparedRuntime.manifest.commands,
      caps: preparedRuntime.manifest.caps,
    },
    signal: getAsyncWorkSignal(),
    log: (message) => defaultRuntime.log(message),
  });
  getAsyncWorkSignal()?.throwIfAborted();
  const gateway = { kind: "openclaw-id" as const, openclawId: target };
  const result = await runNodeHost({
    gatewayTarget: gateway,
    gatewayHost: "",
    gatewayPort: 0,
    displayName,
    commands,
    allCommands: opts.allCommands,
    preparedRuntime,
    ...(opts.service ? { stopAfterFirstConnect: true } : {}),
  });
  if (opts.service) {
    getAsyncWorkSignal()?.throwIfAborted();
    if (!result?.connected) {
      throw new Error("Node did not complete its first connection; service was not installed.");
    }
    await runNodeDaemonInstall({
      displayName,
      commands,
      allCommands: opts.allCommands,
      force: true,
    });
  }
}
