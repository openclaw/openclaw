import { Option, type Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { loadDeviceIdentityIfPresentAsync } from "../../infra/device-identity-async.js";
import { publicKeyRawBase64UrlFromPem } from "../../infra/device-identity.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import { inheritOptionFromParent } from "../command-options.js";
import { formatInvalidPortOption } from "../error-format.js";
import { ExpectedCliError } from "../failure-output.js";
import { formatHelpExamples } from "../help-format.js";
import { addNodeCommandOptions, createNodeWorkerCommand } from "./command-options.js";
import { resolveNodeGatewayOptions, resolveNodePairGatewayOptions } from "./gateway-options.js";

function addNodeGatewayOptions(command: Command): Command {
  return command
    .option("--host <host>", "Gateway host")
    .option("--port <port>", "Gateway port")
    .option("--context-path <path>", "Gateway WebSocket context path (e.g. /openclaw-gw)")
    .option("--tls", "Use TLS for the gateway connection")
    .option("--no-tls", "Disable TLS for the gateway connection")
    .option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)")
    .option("--node-id <id>", "Override the generated node instance id")
    .option("--display-name <name>", "Override node display name");
}

export function registerNodeCli(program: Command) {
  const node = addNodeCommandOptions(
    program.command("node").description("Run and manage the headless node host service"),
  ).addHelpText(
    "after",
    () =>
      `\n${theme.heading("Examples:")}\n${formatHelpExamples([
        ["openclaw node run --host 127.0.0.1 --port 18789", "Run the node host in the foreground."],
        ["openclaw node status", "Check node host service status."],
        ["openclaw node install", "Install the node host service."],
        ["openclaw node start", "Start the installed node host service."],
        ["openclaw node restart", "Restart the installed node host service."],
      ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/node", "docs.openclaw.ai/cli/node")}\n`,
  );

  node.addCommand(
    createNodeWorkerCommand().action(async (opts: { desktopSharing?: boolean }) => {
      const { runNodeHostWorker } = await import("../../node-host/worker.js");
      await runNodeHostWorker({ desktopSharingEnabled: opts.desktopSharing });
    }),
    { hidden: true },
  );

  addNodeGatewayOptions(
    addNodeCommandOptions(
      node.command("run").description("Run the headless node host (foreground)"),
    )
      .option(
        "--pair <code-or-url>",
        "Pair with a setup code or oc-pair URL; explicit gateway flags take precedence",
      )
      .addOption(
        new Option(
          "--pair-if-needed <code-or-url>",
          "Use the saved device token when available; otherwise pair with this setup code",
        ).conflicts("pair"),
      ),
  )
    .option("--session-host", "Host worker sessions for this foreground process")
    .addOption(new Option("--ephemeral").hideHelp())
    .addOption(new Option("--desktop-sharing").hideHelp())
    .addOption(new Option("--no-desktop-sharing").hideHelp())
    .option(
      "--auth-from-env",
      "Use environment Gateway credentials instead of the paired device token",
    )
    .addOption(new Option("--parent-stdin").hideHelp())
    .option("--share-installed-apps", "Share installed macOS applications with the Gateway")
    .option("--no-share-installed-apps", "Disable installed application sharing")
    .action(async (opts, command: Command) => {
      let pair;
      let gatewayOptions;
      try {
        const setupCode = opts.pair ?? opts.pairIfNeeded;
        pair = setupCode
          ? resolveNodePairGatewayOptions(setupCode, {
              allowExpired: opts.pairIfNeeded !== undefined,
            })
          : undefined;
        const existing = await loadNodeHostConfig();
        gatewayOptions = resolveNodeGatewayOptions(opts, existing, pair);
      } catch (error) {
        defaultRuntime.error(error instanceof Error ? error.message : String(error));
        defaultRuntime.exit(1);
        return;
      }
      const { host, port, contextPath, tls, tlsFingerprint, cloudflareAccess, gatewayCandidates } =
        gatewayOptions;
      if (port === null) {
        defaultRuntime.error(formatInvalidPortOption("--port"));
        defaultRuntime.exit(1);
        return;
      }
      if (opts.tls === false && opts.tlsFingerprint !== undefined) {
        defaultRuntime.error("--no-tls cannot be combined with --tls-fingerprint");
        defaultRuntime.exit(1);
        return;
      }
      const { runNodeHost } = await import("../../node-host/runner.js");
      await runNodeHost({
        gatewayHost: host,
        gatewayPort: port,
        gatewayTls: tls,
        gatewayTlsFingerprint: tlsFingerprint,
        gatewayContextPath: contextPath,
        gatewayCloudflareAccess: cloudflareAccess,
        gatewayCandidates,
        gatewayBootstrapToken: pair?.bootstrapToken,
        gatewayBootstrapExpiresAtMs: pair?.expiresAtMs,
        preferGatewayBootstrapToken: opts.pair !== undefined,
        ...(opts.ephemeral === true || opts.sessionHost === true ? { forceWorkerRuns: true } : {}),
        ...(opts.ephemeral === true ? { ephemeral: true } : {}),
        nodeId: opts.nodeId,
        displayName: opts.displayName,
        installedAppsSharing: opts.shareInstalledApps,
        desktopSharingEnabled: opts.desktopSharing,
        gatewayAuthFromEnv: opts.authFromEnv,
        parentStdin: opts.parentStdin,
        commands: opts.commands ?? inheritOptionFromParent<string[]>(command, "commands"),
        allCommands: opts.allCommands ?? inheritOptionFromParent<boolean>(command, "allCommands"),
      });
    });

  node
    .command("status")
    .description("Show node host status")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const { runNodeDaemonStatus } = await import("./daemon.js");
      await runNodeDaemonStatus(opts);
    });

  node
    .command("identity")
    .description("Print the node host device identity (device id + public key)")
    .option("--identity <key>", "Identity key: primary, node, or shareExtension", "primary")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean; identity?: string }) => {
      // SSH pairing probes must never mint an identity on a host that has not run the node host.
      const identityKey = opts.identity ?? "primary";
      if (!["primary", "node", "shareExtension"].includes(identityKey)) {
        const message = "identity must be primary, node, or shareExtension";
        throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
      }
      const identity = await loadDeviceIdentityIfPresentAsync({ identityKey });
      if (!identity) {
        const message =
          "no node device identity found (start the node host once with `openclaw node run` or `openclaw node install`)";
        throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
      }
      const payload = {
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      };
      if (opts.json) {
        writeRuntimeJson(defaultRuntime, payload, 0);
        return;
      }
      defaultRuntime.log(`deviceId:  ${payload.deviceId}`);
      defaultRuntime.log(`publicKey: ${payload.publicKey}`);
    });

  addNodeGatewayOptions(
    addNodeCommandOptions(
      node
        .command("install")
        .description("Install the node host service (launchd/systemd/schtasks)"),
    ),
  )
    .option("--share-installed-apps", "Share installed macOS applications with the Gateway")
    .option("--no-share-installed-apps", "Disable installed application sharing")
    .option("--runtime <runtime>", "Service runtime (node|bun). Default: node")
    .option("--runtime-path <path>", "Pin an absolute Node/Bun executable path")
    .addOption(
      new Option("--expected-runtime-pin <json>", "Require the observed runtime intent").hideHelp(),
    )
    .addOption(
      new Option("--restore-service-cli <json>", "Restore a retained service CLI").hideHelp(),
    )
    .option(
      "--auth-from-env",
      "Persist environment Gateway credentials instead of the paired device token",
    )
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (opts, command: Command) => {
      const { runNodeDaemonInstall } = await import("./daemon.js");
      await runNodeDaemonInstall({
        ...opts,
        commands: opts.commands ?? inheritOptionFromParent<string[]>(command, "commands"),
        allCommands: opts.allCommands ?? inheritOptionFromParent<boolean>(command, "allCommands"),
      });
    });

  for (const name of ["uninstall", "stop", "start", "restart"] as const) {
    node
      .command(name)
      .description(
        `${name.charAt(0).toUpperCase()}${name.slice(1)} the node host service (launchd/systemd/schtasks)`,
      )
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        const { runNodeDaemonLifecycle } = await import("./daemon.js");
        await runNodeDaemonLifecycle(name, opts);
      });
  }
}
