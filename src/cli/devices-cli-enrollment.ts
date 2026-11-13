// Explicit interactive enrollment; ordinary maintenance RPCs keep their existing identity.
import { createHash, randomUUID } from "node:crypto";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { UserProfile } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import {
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceTokenReadOnly,
  storeDeviceAuthToken,
  storeOriginDeviceToken,
} from "../infra/device-auth-store.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { ExpectedCliError, throwExpectedCliError } from "./expected-cli-error.js";
import { prepareCliGatewayStateAccess } from "./gateway-rpc.runtime.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { loadInteractiveOperatorDeviceIdentity } from "./interactive-device-auth.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export type EnrollmentOptions = GatewayRpcOpts & {
  device?: string;
  person?: string;
  name?: string;
  enrollmentId?: string;
  config?: OpenClawConfig;
  ignoreEnvUrlOverride?: boolean;
  tlsFingerprint?: string;
};
type EnrollmentResult = {
  deviceId: string;
  profileId: string;
  operatorToken?: { token: string; scopes: string[] };
};
export type ConfirmedOperatorEnrollment = {
  deviceId: string;
  profileId: string;
  gatewayUrl: string;
};

export type OperatorPersonChoice =
  | { kind: "keep" }
  | { kind: "existing"; profileId: string }
  | { kind: "new"; name?: string };

/** Stable retry alias for this installation, Gateway and prior confirmed association; never identity proof. */
function localEnrollmentIntent(deviceId: string, gateway: string, previousProfileId: string) {
  const digest = createHash("sha1")
    .update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(
      "openclaw:personal-enrollment:v1:" + JSON.stringify([deviceId, gateway, previousProfileId]),
    )
    .digest("hex");
  const uuid =
    digest.slice(0, 12) +
    "5" +
    digest.slice(13, 16) +
    ((Number.parseInt(digest.slice(16, 17), 16) & 3) | 8).toString(16) +
    digest.slice(17, 32);
  return [
    uuid.slice(0, 8),
    uuid.slice(8, 12),
    uuid.slice(12, 16),
    uuid.slice(16, 20),
    uuid.slice(20),
  ].join("-");
}

/** The CLI formatter and attended onboarding share one mutation and credential owner. */
export async function enrollDevicesOperator(
  opts: EnrollmentOptions,
  beforeEnroll?: (config: OpenClawConfig, selectedProfile?: UserProfile) => Promise<void>,
  choosePerson?: (choices: {
    current?: UserProfile;
    profiles?: UserProfile[];
  }) => Promise<OperatorPersonChoice>,
): Promise<ConfirmedOperatorEnrollment> {
  if (opts.person && (opts.name !== undefined || opts.enrollmentId)) {
    throwExpectedCliError("Choose --person or a new --name/--enrollment-id, not both.");
  }
  let enrollmentId = opts.person
    ? undefined
    : (opts.enrollmentId ?? (choosePerson ? undefined : randomUUID()));
  let person = opts.person;
  let name = opts.name;
  await prepareCliGatewayStateAccess();
  const config = opts.config ?? loadConfig();
  const target = await resolveGatewayClientBootstrap({
    config,
    gatewayUrl: opts.url,
    explicitAuth: { token: opts.token, password: opts.password },
    ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
    explicitTlsFingerprint: opts.tlsFingerprint,
  });
  if (opts.expectUrl !== undefined && target.url !== opts.expectUrl) {
    throw new Error("Gateway destination changed. Refresh onboarding before retrying.");
  }
  const identity = opts.device ? undefined : await loadInteractiveOperatorDeviceIdentity(true);
  const connection = {
    config,
    url: opts.url,
    expectUrl: target.url,
    ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
    tlsFingerprint: opts.tlsFingerprint,
    deviceIdentity: identity,
    ...(identity ? { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.CLI } : {}),
    timeoutMs: parseTimeoutMsWithFallback(opts.timeout, 30_000, { invalidType: "error" }),
  };
  let result: EnrollmentResult | undefined;
  let selectedProfile: UserProfile | undefined;
  let useStoredDeviceAuth = false;
  if (choosePerson) {
    if (!identity) {
      throw new Error("Attended person selection requires this terminal's installation identity.");
    }
    const lookup = { deviceId: identity.deviceId, role: "operator" };
    const stored = target.deviceAuthScope
      ? await loadOriginDeviceTokenReadOnly({ ...lookup, gatewayScope: target.deviceAuthScope })
      : await loadDeviceAuthTokenReadOnly(lookup);
    useStoredDeviceAuth = stored !== null;
    let isAdmin = false;
    const current = await callGateway<{ profile: UserProfile }>({
      ...connection,
      method: "users.self",
      params: {},
      ...(useStoredDeviceAuth
        ? { useStoredDeviceAuth: true }
        : { token: opts.token, password: opts.password, scopes: ["operator.admin"] }),
      onHelloOk: (hello) => {
        isAdmin =
          hello.auth.roleAllowsAdmin !== false && hello.auth.scopes.includes("operator.admin");
      },
    });
    const profile = current.profile.id !== GATEWAY_OWNER_PROFILE_ID ? current.profile : undefined;
    const directory = isAdmin
      ? await callGateway<{ profiles: UserProfile[] }>({
          ...connection,
          method: "users.list",
          params: {},
          scopes: ["operator.admin"],
          ...(useStoredDeviceAuth
            ? { useStoredDeviceAuth: true }
            : { token: opts.token, password: opts.password }),
        })
      : undefined;
    const profiles = directory?.profiles.filter(
      (entry) => entry.id !== GATEWAY_OWNER_PROFILE_ID && entry.mergedInto === null,
    );
    const choice = await choosePerson({ current: profile, profiles });
    if (choice.kind === "keep") {
      if (!profile) {
        throw new Error("There is no current personal identity to keep.");
      }
      result = { deviceId: identity.deviceId, profileId: profile.id };
    } else {
      if (!isAdmin) {
        throw new Error("Changing represented people requires the current Gateway administrator.");
      }
      if (choice.kind === "existing") {
        selectedProfile = profiles?.find((entry) => entry.id === choice.profileId);
        if (!selectedProfile) {
          throw new Error("The selected person is no longer available. Refresh personal setup.");
        }
        person = selectedProfile.id;
      } else {
        name = choice.name;
        enrollmentId = localEnrollmentIntent(
          identity.deviceId,
          target.deviceAuthScope ?? target.url,
          profile?.id ?? GATEWAY_OWNER_PROFILE_ID,
        );
      }
    }
  }
  const recoveryHint = () =>
    enrollmentId
      ? " Retry the same intent with " +
        formatCliCommand(
          "openclaw devices enroll --enrollment-id " +
            enrollmentId +
            (opts.url ? " --url " + quoteCliArg(opts.url) : ""),
        ) +
        ". Use the same Gateway and original credentials."
      : "";
  const requestAuth = useStoredDeviceAuth
    ? { useStoredDeviceAuth: true }
    : { token: opts.token, password: opts.password };
  try {
    if (!result && beforeEnroll) {
      const snapshot = await callGateway<{ config: OpenClawConfig; valid: boolean }>({
        ...connection,
        ...requestAuth,
        method: "config.get",
        params: {},
        scopes: ["operator.admin"],
      });
      if (!snapshot.valid) {
        throw new Error(
          "The selected Gateway configuration is invalid. Repair it before enrollment.",
        );
      }
      await beforeEnroll(snapshot.config, selectedProfile);
    }
    result ??= await callGateway<EnrollmentResult>({
      ...connection,
      ...requestAuth,
      method: "device.profile.enroll",
      scopes: ["operator.admin"],
      params: {
        ...(opts.device ? { deviceId: opts.device } : {}),
        ...(person
          ? { profileId: person }
          : { enrollmentId, ...(name !== undefined ? { name } : {}) }),
      },
    });
  } catch (cause) {
    const recovery = recoveryHint();
    const message =
      "Device enrollment did not return a confirmed result. " +
      formatErrorMessage(cause) +
      recovery;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message, cause });
  }
  if (identity && result.deviceId !== identity.deviceId) {
    throw new Error("Enrollment returned another device; no credential was adopted.");
  }
  if (result.operatorToken && identity) {
    const token = { deviceId: identity.deviceId, role: "operator", ...result.operatorToken };
    try {
      const saved = target.deviceAuthScope
        ? await storeOriginDeviceToken({ ...token, gatewayScope: target.deviceAuthScope })
        : await storeDeviceAuthToken(token);
      if (!saved) {
        throw new Error("The credential store did not confirm the write.");
      }
    } catch (cause) {
      throw new Error(
        "Enrollment was committed, but the local operator credential was not saved. Repair pairing for device " +
          result.deviceId +
          "; do not create another person." +
          recoveryHint(),
        { cause },
      );
    }
  }
  if (identity) {
    try {
      let deviceTokenAdmission = false;
      const current = await callGateway<{ profile: UserProfile }>({
        ...connection,
        method: "users.self",
        params: {},
        // Never prove enrollment with the shared owner secret used to request it.
        useStoredDeviceAuth: true,
        onHelloOk: (hello) => {
          deviceTokenAdmission = hello.auth.method === "device-token";
        },
        assertDispatchCurrent: () => {
          if (!deviceTokenAdmission) {
            throw new Error("Personal enrollment did not reconnect with its operator credential.");
          }
        },
      });
      if (!deviceTokenAdmission || current.profile.id !== result.profileId) {
        throw new Error("The current operator admission does not match the enrolled person.");
      }
    } catch (cause) {
      throw new Error(
        "Enrollment was committed, but personal admission is not confirmed. Repair this device's pairing; do not create another person." +
          recoveryHint(),
        { cause },
      );
    }
  }
  return { deviceId: result.deviceId, profileId: result.profileId, gatewayUrl: target.url };
}

export async function runDevicesEnrollmentCommand(opts: EnrollmentOptions) {
  const result = await enrollDevicesOperator(opts);
  // Tokens remain in the local credential owner, including under --json.
  if (opts.json) {
    defaultRuntime.writeJson({ deviceId: result.deviceId, profileId: result.profileId });
  } else {
    defaultRuntime.log(
      "Enrolled operator device " +
        result.deviceId +
        " as profile " +
        result.profileId +
        ". Shared maintenance authentication is unchanged.",
    );
  }
}
