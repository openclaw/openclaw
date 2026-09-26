import type {
  DeviceBootstrapProfile,
  DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairSetupCompletionRecord,
  PairedDevice,
} from "./device-pairing.types.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

export type BoundDeviceBootstrapContext = {
  profile: DeviceBootstrapProfile;
  setupId?: string;
};

export type DeviceBootstrapBoundContextInput = {
  token: string;
  deviceId: string;
  publicKey: string;
  nowMs: number;
};

export type DeviceBootstrapMutationAdmission =
  | { kind: "bootstrap.consume"; pairedDevice: PairedDevice | null; issuedAtMs: number }
  | { kind: "bootstrap.token"; issuedAtMs: number };

export type DeviceBootstrapOperations = {
  "bootstrap.issue": {
    input: { profile: DeviceBootstrapProfile; setupId?: string; nowMs: number };
    output: { token: string; expiresAtMs: number };
  };
  "bootstrap.ensure": {
    input: { profile: DeviceBootstrapProfileInput; setupId: string; nowMs: number };
    output:
      | { status: "pending"; token: string; expiresAtMs: number; setupId: string }
      | { status: "completed"; setupId: string; deviceId: string };
  };
  "bootstrap.consume": {
    input: { token: string; deviceId: string; completedAtMs: number; nowMs: number };
    output: {
      record: DeviceBootstrapTokenRecord;
      completion?: DevicePairSetupCompletionRecord;
    } | null;
  };
  "bootstrap.confirm": {
    input: { setupId: string; deviceId: string; nowMs: number };
    output: DevicePairSetupCompletionRecord | null;
  };
  "bootstrap.readCompletion": {
    input: { setupId: string; nowMs: number };
    output: DevicePairSetupCompletionRecord | null;
  };
  "bootstrap.prune": {
    input: { nowMs: number };
    output: number;
  };
  "bootstrap.clear": {
    input: { nowMs: number };
    output: { removed: number };
  };
  "bootstrap.revoke": {
    input: { token: string; nowMs: number };
    output: { removed: boolean; record?: DeviceBootstrapTokenRecord };
  };
  "bootstrap.restore": {
    input: { record: DeviceBootstrapTokenRecord; nowMs: number };
    output: boolean;
  };
  "bootstrap.redeem": {
    input: { token: string; role: string; scopes: readonly string[]; nowMs: number };
    output: { recorded: boolean; fullyRedeemed: boolean };
  };
  "bootstrap.verify": {
    input: DeviceBootstrapBoundContextInput & { role: string; scopes: readonly string[] };
    output: { ok: true } | { ok: false; reason: string };
  };
};

export type DeviceBootstrapCommand = SqliteWorkerCommand<DeviceBootstrapOperations>;
