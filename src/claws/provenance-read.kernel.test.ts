import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  readClawInstallRecordFromDatabase,
  readClawInstallRecordsInDatabase,
  readClawPackageRefsInDatabase,
} from "./provenance-read.kernel.js";

describe("historical Claw provenance reads", () => {
  it("projects missing additive fields as absent provenance", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO claw_installs (
          agent_id, schema_version, source_kind, claw_name, claw_version,
          package_root, manifest_path, integrity_kind, integrity, source_byte_length,
          manifest_schema_version, plan_integrity, workspace, agent_config_digest,
          agent_owned_paths_json, status, added_at_ms, updated_at_ms
        ) VALUES (
          'research', 'openclaw.clawInstallRecord.v2', 'package', '@openclaw/research', '1.0.0',
          '/packages/research', '/packages/research/openclaw.claw.json', 'artifact',
          'sha256:manifest', 123, 1, 'sha256:plan', '/workspaces/research',
          'sha256:config', '[]', 'complete', 100, 100
        );
        INSERT INTO claw_package_refs (
          agent_id, package_kind, package_source, package_ref, package_version,
          package_integrity, schema_version, claw_name, package_status,
          relationship, origin, independent_owner, installed_at_ms, updated_at_ms
        ) VALUES (
          'research', 'skill', 'clawhub', '@openclaw/research-skill', '1.0.0',
          'sha256:skill', 'openclaw.clawPackageRef.v1', '@openclaw/research',
          'complete', 'managed', 'claw-introduced', 0, 100, 100
        );
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
        ALTER TABLE claw_package_refs DROP COLUMN extension_id;
        ALTER TABLE claw_package_refs DROP COLUMN extension_format;
        ALTER TABLE claw_package_refs DROP COLUMN extension_detected_format;
        ALTER TABLE claw_package_refs DROP COLUMN extension_mapped_json;
        ALTER TABLE claw_package_refs DROP COLUMN extension_unavailable_json;
        ALTER TABLE claw_package_refs DROP COLUMN extension_adapter_identity;
      `);

      expect(readClawInstallRecordFromDatabase(db, "research")).toMatchObject({
        agentId: "research",
      });
      expect(readClawInstallRecordFromDatabase(db, "research")?.bootstrap).toBeUndefined();
      expect(readClawInstallRecordsInDatabase(db)).toHaveLength(1);
      expect(readClawPackageRefsInDatabase(db, { agentId: "research", readOnly: true })).toEqual([
        expect.objectContaining({
          agentId: "research",
          ref: "@openclaw/research-skill",
          status: "complete",
        }),
      ]);
      expect(readClawPackageRefsInDatabase(db)[0]?.extension).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
