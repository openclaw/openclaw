import {
  captureRuntimeConfigAsyncReader,
  getRuntimeConfig,
  getRuntimeConfigSnapshot,
} from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOperatorRolePolicyForAssignment } from "../gateway/operator-role-policy.js";
import {
  assertDeviceBootstrapPersonalSelection,
  normalizeDeviceBootstrapHandoffProfile,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";

/** Retains one physical profile owner and the exact current role through bootstrap effects. */
export async function prepareDeviceBootstrapProfileAuthority(
  input: DeviceBootstrapProfileInput,
  options: {
    baseDir?: string;
    context?: OpenClawStateWorkerContext;
    assertCurrent?: () => void;
    getConfig?: () => OpenClawConfig;
  } = {},
) {
  const context =
    options.context ??
    captureOpenClawStateWorkerContext(
      options.baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: options.baseDir } } : {},
    );
  const profile = normalizeDeviceBootstrapHandoffProfile(input);
  assertDeviceBootstrapPersonalSelection(profile);
  options.assertCurrent?.();
  const profileId = profile.operatorProfileId;
  if (profileId !== undefined && !options.getConfig && !getRuntimeConfigSnapshot()) {
    await captureRuntimeConfigAsyncReader()();
    options.assertCurrent?.();
  }
  const person =
    profileId !== undefined
      ? await prepareUserProfileRoleAuthority(profileId, {
          path: context.admission.databasePath,
          env: context.environment,
        })
      : undefined;
  const readPolicy = () =>
    person &&
    resolveOperatorRolePolicyForAssignment(
      person.profileId,
      person.role,
      (options.getConfig ?? getRuntimeConfig)(),
      person.githubLogin ?? null,
    );
  const initialPolicy = readPolicy();
  if (initialPolicy) {
    profile.scopes = normalizeDeviceBootstrapHandoffProfile({
      ...profile,
      scopes: intersectOperatorScopes(profile.scopes, initialPolicy.scopes),
    }).scopes;
  }
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
    if (profileId === undefined) {
      return;
    }
    if (
      !person ||
      person.profileId !== profileId ||
      !person.isCurrent() ||
      profile.scopes.length === 0
    ) {
      throw new Error("Bootstrap person is missing, stale, or has no operator access");
    }
    const policy = readPolicy();
    if (
      policy &&
      !roleScopesAllow({
        role: "operator",
        requestedScopes: profile.scopes,
        allowedScopes: policy.scopes,
      })
    ) {
      throw new Error("Bootstrap person role no longer permits the issued scopes");
    }
  };
  assertCurrent();
  return { profile, context, assertCurrent };
}
