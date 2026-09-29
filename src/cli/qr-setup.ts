// Interactive phone access recovery. Network defaults and writes remain setup-owned.
import os from "node:os";
import { readConfigFileSnapshotForWrite, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createConfiguredGatewayLocalProbe } from "../gateway/local-http-probe.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
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
import { waitForGatewayDiagnosticReadiness } from "./daemon-cli/diagnostic-readiness.js";
import { runDaemonRestart } from "./daemon-cli/lifecycle.js";
import { allListenersOwnedByRuntimePid } from "./daemon-cli/restart-port-ownership.js";

const RESTART_HELP =
  "Phone access settings were saved, but the Gateway restart did not complete. Run openclaw gateway restart, then openclaw qr. No setup code was issued.";

async function resolveQrPhoneGatewayPid(
  config: OpenClawConfig,
  port: number,
): Promise<number | undefined> {
  const readiness = await waitForGatewayDiagnosticReadiness({
    config,
    localPortOverride: port,
    ignoreEnvUrlOverride: true,
    timeoutMs: 10_000,
  });
  return readiness?.healthy === true &&
    readiness.runtime.pid !== undefined &&
    allListenersOwnedByRuntimePid(readiness.portUsage.listeners, readiness.runtime.pid)
    ? readiness.runtime.pid
    : undefined;
}

/** Shared by activation and issuance, including a retry with already-saved LAN settings. */
export async function verifyQrPhoneGateway(config: OpenClawConfig, url: string): Promise<void> {
  const endpoint = new URL(url);
  const port = Number(endpoint.port || (endpoint.protocol === "wss:" ? 443 : 80));
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const pid = await resolveQrPhoneGatewayPid(config, port);
  // Diagnostic readiness observes loopback. A different process can own the
  // LAN interface at that same port, so inspect the exact advertised host too.
  const advertised =
    pid === undefined ? undefined : await inspectPortUsage(port, { probeHosts: [host] });
  if (
    pid === undefined ||
    !advertised ||
    advertised.status !== "busy" ||
    !allListenersOwnedByRuntimePid(advertised.listeners, pid)
  ) {
    throw new Error(
      "The Gateway could not be verified as the owner of the phone address. Run openclaw gateway status and check any OPENCLAW_GATEWAY_PORT override, then run openclaw qr again. No setup code was issued.",
    );
  }
  // Never send the shared Gateway credential across plaintext LAN during this check.
  const reachable = await createConfiguredGatewayLocalProbe(config).requestHttp({
    host,
    port,
    pathname: "/readyz",
    timeoutMs: 10_000,
  });
  if (reachable?.statusCode !== 200) {
    throw new Error(
      "The phone address is not ready yet. Run openclaw gateway status, then openclaw qr after the Gateway is ready. No setup code was issued.",
    );
  }
}

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
      { value: "cancel", label: "Not now", hint: "Leave the Gateway unchanged" },
    ],
  });
  if (connection !== "lan") {
    throw new WizardCancelledError("Phone setup cancelled. Nothing changed.");
  }
  const nextConfig = await configureGatewayNetworkForSetup(config, {
    bind: "lan",
    tailscaleMode: "off",
  });
  const planned = await resolveUrl(nextConfig);
  if (!planned.url) {
    throw new Error(
      "No local network address was found. Connect this computer to the same Wi-Fi or network as your phone, then run openclaw qr again. Nothing changed.",
    );
  }
  const plannedPort = resolveGatewayPort(nextConfig);
  if ((await resolveQrPhoneGatewayPid(snapshot.config, plannedPort)) === undefined) {
    throw new Error(
      "The Gateway could not be verified as the owner of the phone address. Run openclaw gateway status and check any OPENCLAW_GATEWAY_PORT override, then run openclaw qr again. Nothing changed; no setup code was issued.",
    );
  }
  await prompter.note(
    "This allows connections to your Gateway on all network interfaces, not just this computer. Use a trusted network and keep your firewall enabled. Authentication stays enabled. Without TLS, pairing is unencrypted and grants limited access.",
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
  await verifyQrPhoneGateway(committed.nextConfig, planned.url);
  return committed.nextConfig;
}
