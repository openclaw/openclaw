import {
  ErrorCodes,
  errorShape,
  validateDevicePairSetupCodeParams,
  validateDevicePairSetupStatusParams,
  type DevicePairSetupCodeResult,
  type DevicePairSetupStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { quoteCliArg } from "../../cli/quote-cli-arg.js";
import { readDevicePairSetupCompletion } from "../../infra/device-bootstrap.js";
import { registerDevicePairingJoinCode } from "../../infra/device-pairing-join-code.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { channelToNpmTag, resolveEffectiveUpdateChannel } from "../../infra/update-channels.js";
import { currentUpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check-package-target.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { renderQrPngDataUrl } from "../../media/qr-image.js";
import {
  decodePairingSetupCode,
  encodePairingSetupCode,
  resolvePairingSetupFromConfig,
} from "../../pairing/setup-code.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../../shared/device-bootstrap-profile.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { VERSION } from "../../version.js";
import { isLoopbackHost } from "../net.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

// Keep the rendered QR within the result schema's qrDataUrl bound. A pathological
// publicUrl can produce a setup code whose QR PNG data URL exceeds the limit; in
// that case we omit the QR (the client can still render one from setupCode)
// rather than return a response that violates the protocol schema.
const MAX_QR_DATA_URL_LENGTH = 16_384;
type PairingSetupPayload = ReturnType<typeof decodePairingSetupCode>;

function resolveDevicePairingJoinBaseUrl(payload: PairingSetupPayload): URL {
  for (const candidate of payload.urls ?? [payload.url]) {
    const parsed = new URL(candidate);
    if (
      parsed.protocol === "wss:" ||
      (parsed.protocol === "ws:" && isLoopbackHost(parsed.hostname))
    ) {
      parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
      return parsed;
    }
  }
  throw new Error(
    "Join URLs require a TLS gateway endpoint, except for loopback. Use the setup code directly for plaintext LAN pairing.",
  );
}

async function resolveJoinPackage(): Promise<{ packageSpec: string; versionNote?: string }> {
  const status = currentUpdateCheckLifecycle().installStatus?.status ?? {
    installKind: await resolveUpdateInstallKind(
      await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, argv1: process.argv[1] }),
      { timeoutMs: 1_000 },
    ).catch(() => "unknown" as const),
  };
  const versionNote =
    "The machine needs a matching Gateway build; the exact npm release could not be confirmed.";
  if (status.installKind === "package" || status.installKind === "host") {
    const exact = await fetchNpmPackageTargetStatus({ target: VERSION, timeoutMs: 1_000 });
    if (exact.version === VERSION) {
      return { packageSpec: `openclaw@${VERSION}` };
    }
  }
  const channel = resolveEffectiveUpdateChannel({
    currentVersion: VERSION,
    ...status,
  }).channel;
  const tag = channelToNpmTag(channel);
  const fallback = await fetchNpmPackageTargetStatus({ target: tag, timeoutMs: 1_000 });
  return {
    packageSpec: fallback.version ? `openclaw@${tag}` : "openclaw",
    versionNote,
  };
}

export const devicePairSetupHandlers: GatewayRequestHandlers = {
  "device.pair.setupCode": async (options) => {
    const { params, respond, context } = options;
    if (
      !assertValidParams(
        params,
        validateDevicePairSetupCodeParams,
        "device.pair.setupCode",
        respond,
      )
    ) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      if (
        params.joinUrl === true &&
        params.bootstrapProfile !== undefined &&
        params.bootstrapProfile !== "node"
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Join URLs require bootstrapProfile=node."),
        );
        return;
      }
      const config = context.getRuntimeConfig();
      const joinContext = params.joinUrl === true ? captureOpenClawStateWorkerContext() : undefined;
      const authority = readGatewayRequestMutationAuthority(options);
      const assertJoinCurrent = joinContext
        ? () => {
            joinContext.admission.assertCurrent();
            authority.assertCurrent();
            if (context.getRuntimeConfig() !== config) {
              throw new Error("Device pairing setup configuration changed.");
            }
          }
        : undefined;
      assertJoinCurrent?.();
      const requestPublicUrl = params.publicUrl;
      const resolved = await resolvePairingSetupFromConfig(config, {
        env: process.env,
        publicUrl: requestPublicUrl,
        preferRemoteUrl: params.preferRemoteUrl === true,
        useLocalGateway: config.gateway?.mode === "remote" && params.preferRemoteUrl !== true,
        localTlsFingerprint: context.gatewayTlsFingerprint,
        ...(params.joinUrl === true || params.bootstrapProfile
          ? {
              bootstrapProfile:
                params.joinUrl === true || params.bootstrapProfile === "node"
                  ? NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE
                  : params.bootstrapProfile === "voice-node"
                    ? VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE
                    : PAIRING_SETUP_BOOTSTRAP_PROFILE,
            }
          : {}),
        // Lets Tailscale serve/funnel URLs resolve, mirroring the `openclaw qr` CLI.
        runCommandWithTimeout: async (argv, runOpts) =>
          await runCommandWithTimeout(argv, { timeoutMs: runOpts.timeoutMs }),
      });
      assertJoinCurrent?.();
      if (!resolved.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
        return;
      }
      const setupCode = encodePairingSetupCode(resolved.payload);
      let joinUrl: string | undefined;
      let joinCommands:
        | Pick<
            DevicePairSetupCodeResult,
            "command" | "serviceCommand" | "installedCommand" | "versionNote"
          >
        | undefined;
      if (params.joinUrl === true) {
        const parsedJoinUrl = resolveDevicePairingJoinBaseUrl(resolved.payload);
        const { packageSpec, versionNote } = await resolveJoinPackage();
        assertJoinCurrent?.();
        const shortcode = await registerDevicePairingJoinCode({
          payload: resolved.payload,
          expiresAtMs: resolved.expiresAtMs,
          context: joinContext,
          assertCurrent: assertJoinCurrent,
        });
        const basePath = parsedJoinUrl.pathname.replace(/\/+$/u, "");
        parsedJoinUrl.pathname = `${basePath}/j/${shortcode}`;
        parsedJoinUrl.search = "";
        parsedJoinUrl.hash = "";
        joinUrl = parsedJoinUrl.toString();
        const target = quoteCliArg(joinUrl);
        const serviceCommand = `npx -y ${packageSpec} connect ${target} --service`;
        joinCommands = {
          command: `${serviceCommand} --session-host`,
          serviceCommand,
          installedCommand: `openclaw connect ${target} --service --session-host`,
          ...(versionNote ? { versionNote } : {}),
        };
      }
      const includeQr = params.includeQr !== false;
      // QR rendering is optional output; keep the usable setup code if encoding fails.
      const renderedQr = includeQr
        ? await renderQrPngDataUrl(setupCode).catch(() => undefined)
        : undefined;
      const qrDataUrl =
        renderedQr && renderedQr.length <= MAX_QR_DATA_URL_LENGTH ? renderedQr : undefined;
      assertJoinCurrent?.();
      respond(
        true,
        {
          setupId: resolved.setupId,
          expiresAtMs: resolved.expiresAtMs,
          setupCode,
          ...(joinUrl ? { joinUrl, ...joinCommands } : {}),
          ...(qrDataUrl ? { qrDataUrl } : {}),
          gatewayUrl: resolved.payload.url,
          ...(resolved.payload.urls ? { gatewayUrls: resolved.payload.urls } : {}),
          // Label only — never the raw gateway token/password.
          auth: resolved.authLabel,
          urlSource: requestPublicUrl ? "request.publicUrl" : resolved.urlSource,
          access: resolved.access,
          ...(resolved.accessDowngraded ? { accessDowngraded: true } : {}),
        },
        undefined,
      );
    });
  },
  // Recovery path for the best-effort device.pair.setup.completed broadcast: a
  // client that missed the frame must not present a redeemed setup as expired.
  "device.pair.setupStatus": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateDevicePairSetupStatusParams,
        "device.pair.setupStatus",
        respond,
      )
    ) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const completion = await readDevicePairSetupCompletion({ setupId: params.setupId });
      // Retention bookkeeping stays server-side; the wire shape matches the
      // corresponding success or delivery-uncertain broadcast.
      let result: DevicePairSetupStatusResult = {};
      if (completion) {
        const payload = {
          setupId: completion.setupId,
          deviceId: completion.deviceId,
          ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
          access: completion.access,
          ts: completion.completedAtMs,
        };
        result =
          completion.deliveryState === "confirmed"
            ? { completion: payload }
            : { deliveryUncertain: payload };
      }
      respond(true, result, undefined);
    });
  },
};
