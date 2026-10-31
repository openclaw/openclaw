import { describe, expect, it } from "vitest";
import {
  decodeWorkerEnvironmentRow,
  profileSnapshotFrom,
  recordsFromRows,
} from "./store-row-codec.js";

function row(environmentId: string, profileSnapshotJson: string) {
  return {
    environment_id: environmentId,
    provider_id: "provider",
    profile_id: "profile",
    profile_snapshot_json: profileSnapshotJson,
    preparation_key: null,
    preparation_purpose: null,
    preparation_demand_at_ms: null,
    preparation_expires_at_ms: null,
    preparation_consumed_at_ms: null,
    provision_operation_id: null,
    node_setup_id: null,
    node_device_id: null,
    shared_host: null,
    lease_id: null,
    ssh_host: null,
    ssh_port: null,
    ssh_user: null,
    ssh_host_key: null,
    ssh_key_ref_json: null,
    desktop_json: null,
    bootstrap_bundle_hash: null,
    bootstrap_openclaw_version: null,
    bootstrap_protocol_features_json: null,
    bootstrap_install_kind: null,
    owner_epoch: 1,
    teardown_terminal_state: null,
    state: "requested",
    attached_session_ids_json: "[]",
    created_at_ms: 1,
    updated_at_ms: 1,
    state_changed_at_ms: 1,
    last_activated_at_ms: null,
    idle_since_at_ms: null,
    destroy_requested_at_ms: null,
    last_error: null,
    ssh_fallback_port: null,
  };
}

describe("worker environment profile snapshots", () => {
  it("accepts a snapshot stored before a project exists", () => {
    const snapshot = profileSnapshotFrom("env-ok", JSON.stringify({ install: "bundle", settings: {} }));
    expect(snapshot.settings).toEqual({});
  });

  it("names the environment when the snapshot is null, empty, or truncated", () => {
    expect(() => profileSnapshotFrom("env-null", "null")).toThrow(/env-null/);
    expect(() => profileSnapshotFrom("env-empty", "{}")).toThrow(/env-empty/);
    expect(() => profileSnapshotFrom("env-bad", "{")).toThrow(/env-bad profile snapshot is not valid JSON/);
  });

  it("keeps the other environments when one stored snapshot cannot be decoded", () => {
    const decoded = recordsFromRows(
      [
        row("env-bad", "null"),
        row("env-ok", JSON.stringify({ settings: { provider: "local" } })),
      ],
      { isolateCorruptRows: true },
    );
    expect(decoded.map((record) => record.environmentId)).toEqual(["env-ok"]);
    expect(decoded[0]?.profileSnapshot.settings).toEqual({ provider: "local" });
    expect(() => decodeWorkerEnvironmentRow(row("env-bad", "null"), [])).toThrow(/env-bad/);
  });
});
