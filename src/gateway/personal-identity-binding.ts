import type { PairedDeviceTokenIdentity } from "../infra/device-pairing-core.types.js";

export type PersonalIdentityBindingIntent = Readonly<
  | {
      mode: "personal-identity";
      provider: "tailscale";
      phase: "bind";
      bindingId: string;
      issuedAtMs: number;
    }
  | {
      mode: "personal-identity";
      provider: "tailscale";
      phase: "use";
      bindingId: string;
      profileId: string;
      gatewayId: string;
      issuedAtMs: number;
    }
>;

export type VerifiedPersonalIdentityBindingSource = Readonly<{
  ingress: "tailscale-serve";
  authMethod: "tailscale";
  tailscaleLogin: string;
  sourceClientIp: string;
  canonicalProfileId: string;
  device: PairedDeviceTokenIdentity;
  gatewayId: string;
  signedAtMs: number;
  verifiedAtMs: number;
}>;

export type PersonalIdentityBindingResult = Readonly<{
  mode: "personal-identity";
  provider: "tailscale";
  profileId: string;
  device: PairedDeviceTokenIdentity;
  tailscaleLogin: string;
  sourceClientIp: string;
  gatewayId: string;
}>;

type Binding = PersonalIdentityBindingResult & { bindingId: string };
type Owner = { closed: boolean; bindings: Map<string, Binding> };

const owners = new WeakMap<object, Owner>();

export const PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS = 120_000;

function normalize(value: string): string {
  return value.trim();
}

function sameDevice(left: PairedDeviceTokenIdentity, right: PairedDeviceTokenIdentity): boolean {
  return left.deviceId === right.deviceId && left.key === right.key;
}

function getOwner(gateway: object): Owner {
  let owner = owners.get(gateway);
  if (!owner) {
    owner = { closed: false, bindings: new Map() };
    owners.set(gateway, owner);
  }
  return owner;
}

export function captureGatewayPersonalIdentityBinding(
  gateway: object,
  source: VerifiedPersonalIdentityBindingSource,
  intent: PersonalIdentityBindingIntent,
  nowMs = Date.now(),
): boolean {
  const bindingId = normalize(intent.bindingId);
  const profileId = normalize(source.canonicalProfileId);
  const tailscaleLogin = normalize(source.tailscaleLogin).toLowerCase();
  const sourceClientIp = normalize(source.sourceClientIp);
  const gatewayId = normalize(source.gatewayId);
  if (
    source.ingress !== "tailscale-serve" ||
    source.authMethod !== "tailscale" ||
    intent.mode !== "personal-identity" ||
    intent.provider !== "tailscale" ||
    intent.phase !== "bind" ||
    !bindingId ||
    bindingId.length > 128 ||
    !profileId ||
    !gatewayId ||
    !tailscaleLogin ||
    !sourceClientIp ||
    !source.device.deviceId ||
    !source.device.key ||
    !Number.isSafeInteger(source.signedAtMs) ||
    !Number.isSafeInteger(source.verifiedAtMs) ||
    intent.issuedAtMs !== source.signedAtMs ||
    Math.abs(source.signedAtMs - nowMs) > PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS ||
    Math.abs(source.verifiedAtMs - source.signedAtMs) > PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS
  ) {
    return false;
  }
  const owner = getOwner(gateway);
  if (owner.closed) {
    return false;
  }
  owner.bindings.set(source.device.deviceId, {
    mode: "personal-identity",
    provider: "tailscale",
    bindingId,
    profileId,
    device: Object.freeze({ ...source.device }),
    tailscaleLogin,
    sourceClientIp,
    gatewayId,
  });
  return true;
}

export async function resolveGatewayPersonalIdentityBinding(params: {
  gateway: object;
  intent: PersonalIdentityBindingIntent;
  device: PairedDeviceTokenIdentity;
  gatewayId: string;
  isDirectLocal: boolean;
  isDeviceCurrent: (device: PairedDeviceTokenIdentity) => boolean | Promise<boolean>;
  isProfileCurrent: (profileId: string, tailscaleLogin: string) => boolean | Promise<boolean>;
  readCurrentTailscaleLogin: (sourceClientIp: string) => Promise<string | undefined>;
  nowMs?: number;
}): Promise<PersonalIdentityBindingResult | undefined> {
  const owner = owners.get(params.gateway);
  const nowMs = params.nowMs ?? Date.now();
  const intent = params.intent;
  const binding = owner?.bindings.get(params.device.deviceId);
  if (
    !owner ||
    owner.closed ||
    !params.isDirectLocal ||
    intent.mode !== "personal-identity" ||
    intent.provider !== "tailscale" ||
    intent.phase !== "use" ||
    !binding ||
    binding.bindingId !== normalize(intent.bindingId) ||
    normalize(intent.profileId) !== binding.profileId ||
    normalize(intent.gatewayId) !== binding.gatewayId ||
    normalize(params.gatewayId) !== binding.gatewayId ||
    !sameDevice(binding.device, params.device) ||
    !Number.isSafeInteger(intent.issuedAtMs) ||
    Math.abs(nowMs - intent.issuedAtMs) > PERSONAL_IDENTITY_SIGNATURE_FRESHNESS_MS
  ) {
    return undefined;
  }
  if (
    !(await isGatewayPersonalIdentityBindingCurrent({
      gateway: params.gateway,
      bindingId: binding.bindingId,
      device: params.device,
      gatewayId: params.gatewayId,
      isDeviceCurrent: params.isDeviceCurrent,
      isProfileCurrent: params.isProfileCurrent,
      readCurrentTailscaleLogin: params.readCurrentTailscaleLogin,
    }))
  ) {
    return undefined;
  }
  if (
    owners.get(params.gateway) !== owner ||
    owner.closed ||
    owner.bindings.get(binding.device.deviceId) !== binding
  ) {
    return undefined;
  }
  return {
    mode: binding.mode,
    provider: binding.provider,
    profileId: binding.profileId,
    device: binding.device,
    tailscaleLogin: binding.tailscaleLogin,
    sourceClientIp: binding.sourceClientIp,
    gatewayId: binding.gatewayId,
  };
}

export async function isGatewayPersonalIdentityBindingCurrent(params: {
  gateway: object;
  bindingId: string;
  device: PairedDeviceTokenIdentity;
  gatewayId: string;
  isDeviceCurrent: (device: PairedDeviceTokenIdentity) => boolean | Promise<boolean>;
  isProfileCurrent: (profileId: string, tailscaleLogin: string) => boolean | Promise<boolean>;
  readCurrentTailscaleLogin: (sourceClientIp: string) => Promise<string | undefined>;
}): Promise<boolean> {
  const owner = owners.get(params.gateway);
  const binding = owner?.bindings.get(params.device.deviceId);
  if (
    !owner ||
    owner.closed ||
    !binding ||
    binding.bindingId !== normalize(params.bindingId) ||
    !sameDevice(binding.device, params.device) ||
    normalize(params.gatewayId) !== binding.gatewayId
  ) {
    return false;
  }
  const bindingIsCurrent = () =>
    !owner.closed && owner.bindings.get(binding.device.deviceId) === binding;
  const deviceIsCurrent = await params.isDeviceCurrent(binding.device);
  if (!bindingIsCurrent()) {
    return false;
  }
  if (!deviceIsCurrent) {
    owner.bindings.delete(binding.device.deviceId);
    return false;
  }
  const profileIsCurrent = await params.isProfileCurrent(binding.profileId, binding.tailscaleLogin);
  if (!bindingIsCurrent()) {
    return false;
  }
  if (!profileIsCurrent) {
    owner.bindings.delete(binding.device.deviceId);
    return false;
  }
  const currentLogin = normalize((await params.readCurrentTailscaleLogin(binding.sourceClientIp)) ?? "");
  if (!bindingIsCurrent()) {
    return false;
  }
  if (!currentLogin || currentLogin.toLowerCase() !== binding.tailscaleLogin) {
    owner.bindings.delete(binding.device.deviceId);
    return false;
  }
  return true;
}

export function revokeGatewayPersonalIdentityBindingsForDevice(
  gateway: object,
  deviceId: string,
): void {
  const owner = owners.get(gateway);
  if (!owner) {
    return;
  }
  owner.bindings.delete(deviceId);
}

export function closeGatewayPersonalIdentityBindings(gateway: object): void {
  const owner = getOwner(gateway);
  owner.closed = true;
  owner.bindings.clear();
}
