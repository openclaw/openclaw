// Interactive phone access recovery. Network defaults and writes remain setup-owned.
import os from "node:os";
import { probeGatewayReachable } from "../commands/onboard-helpers.js";
import { readConfigFileSnapshotForWrite, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createConfiguredGatewayLocalProbe } from "../gateway/local-http-probe.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import {
  resolveConfiguredPairingPublicUrl,
  resolvePairingGatewayUrl,
} from "../pairing/setup-code.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { configureGatewayNetworkForSetup } from "../wizard/setup.gateway-config.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";
import { runDaemonRestart } from "./daemon-cli/lifecycle.js";

const RESTART_HELP =
  "Phone access settings were saved, but the Gateway restart did not complete. Run openclaw gateway restart, then openclaw qr. No setup code was issued.";

export async function setupQrPhoneAccess(): Promise<OpenClawConfig> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Run openclaw doctor to repair your Gateway settings, then openclaw qr.");
  }
  const config = snapshot.sourceConfig ?? snapshot.config;
  // Never turn a remote/proxy client into a directly exposed local Gateway.
  if (config.gateway?.mode === "remote" || config.gateway?.auth?.mode === "trusted-proxy") {
    throw new Error(
      "Use openclaw qr --url with the secure address your phone uses to reach this Gateway.",
    );
  }
  const probeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
    cfg: snapshot.config,
    mode: "local",
    localPrecedence: "env-first",
  });
  if (
    config.gateway?.auth?.mode === "none" ||
    probeAuth.warning ||
    (!probeAuth.auth.token && !probeAuth.auth.password)
  ) {
    throw new Error(
      "Gateway authentication is not ready. Run openclaw configure --section gateway, then openclaw qr. Nothing changed.",
    );
  }
  const resolveUrl = (candidate: OpenClawConfig) =>
    resolvePairingGatewayUrl(candidate, {
      env: process.env,
      publicUrl: resolveConfiguredPairingPublicUrl(candidate),
      networkInterfaces: os.networkInterfaces,
      runCommandWithTimeout,
    });
  const current = await resolveUrl(config);
  if (current.reason !== "loopback") {
    throw new Error("Gateway settings changed. Run openclaw qr again to use the current settings.");
  }

  const prompter = createClackPrompter();
  await prompter.note(
    "Your Gateway is only reachable on this computer. Choose how your phone should connect; nothing changes until you confirm.",
    "Connect your phone",
  );
  const connection = await prompter.select({
    message: "How will your phone connect?",
    options: [
      {
        value: "lan",
        label: "Same Wi-Fi or local network",
        hint: "Use only on a network you trust",
      },
      {
        value: "serve",
        label: "Tailscale",
        hint: "Encrypted access; Tailscale must be connected on both devices",
      },
      { value: "cancel", label: "Not now", hint: "Leave the Gateway unchanged" },
    ],
  });
  if (connection === "cancel") {
    throw new WizardCancelledError("Phone setup cancelled. Nothing changed.");
  }
  const tailscaleBin = connection === "serve" ? await findTailscaleBinary() : null;
  if (connection === "serve" && !tailscaleBin) {
    throw new Error(
      "Install and connect Tailscale on this computer and your phone, then run openclaw qr again. Nothing changed.",
    );
  }
  const nextConfig = await configureGatewayNetworkForSetup(
    config,
    {
      port: resolveGatewayPort(snapshot.config),
      bind: connection === "lan" ? "lan" : "loopback",
      tailscaleMode: connection === "serve" ? "serve" : "off",
    },
    tailscaleBin,
  );
  const planned = await resolveUrl(nextConfig);
  if (!planned.url) {
    throw new Error(
      connection === "lan"
        ? "No local network address was found. Connect this computer to the same Wi-Fi or network as your phone, then run openclaw qr again. Nothing changed."
        : "Tailscale is not ready. Connect Tailscale on both devices and enable MagicDNS and HTTPS in Tailscale, then run openclaw qr again. Nothing changed.",
    );
  }
  await prompter.note(
    connection === "lan"
      ? "This allows connections to your Gateway on all network interfaces, not just this computer. Use a trusted network and keep your firewall enabled. Authentication stays enabled. Without TLS, pairing is unencrypted and grants limited access."
      : "This enables encrypted Tailscale Serve access for devices allowed by your tailnet policy. It does not publish your Gateway to the public internet. Your existing Gateway authentication is preserved.",
    "Phone access",
  );
  if (
    !(await prompter.confirm({
      message:
        "Save these settings and restart the Gateway now? Active connections may be interrupted.",
      initialValue: false,
    }))
  ) {
    throw new WizardCancelledError("Phone setup cancelled. Nothing changed.");
  }
  // Pin both content and destination across the prompts; never persist resolved secrets
  // or CLI overrides, and reject a concurrent settings change before exposing anything.
  const committed = await writeWizardConfigFile(nextConfig, {
    baseSnapshot: snapshot,
    mergeBase: config,
    writeOptions,
    afterWrite: { mode: "none", reason: "qr phone setup owns the confirmed restart" },
  });
  defaultRuntime.log("Phone access settings saved. Restarting the Gateway…");
  try {
    if (!(await runDaemonRestart())) {
      throw new Error(RESTART_HELP);
    }
  } catch {
    throw new Error(RESTART_HELP);
  }
  // A service manager can acknowledge a scheduled restart before it activates.
  // Check the advertised endpoint, not just the old loopback listener. Never send
  // the shared Gateway credential across a plaintext LAN during this check.
  const endpoint = new URL(planned.url);
  const reachable =
    connection === "serve"
      ? (
          await probeGatewayReachable({
            url: planned.url,
            config: committed.nextConfig,
            ...probeAuth.auth,
            timeoutMs: 10_000,
          })
        ).ok
      : (
          await createConfiguredGatewayLocalProbe(committed.nextConfig).requestHttp({
            host: endpoint.hostname.replace(/^\[|\]$/g, ""),
            port: resolveGatewayPort(committed.nextConfig),
            pathname: "/readyz",
            timeoutMs: 10_000,
          })
        )?.statusCode === 200;
  if (!reachable) {
    throw new Error(
      "Phone access settings were saved, but the phone address is not ready yet. Run openclaw gateway status, then openclaw qr after the Gateway is ready. No setup code was issued.",
    );
  }
  return committed.nextConfig;
}
