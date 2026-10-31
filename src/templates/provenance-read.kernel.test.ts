import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  readTemplateInstallRecordFromDatabase,
  readTemplateInstallRecordsInDatabase,
  readTemplatePackageRefsInDatabase,
} from "./provenance-read.kernel.js";

describe("historical Template provenance reads", () => {
  it("projects missing additive fields as absent provenance", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO template_installs (
          agent_id, schema_version, source_kind, template_name, template_version,
          package_root, manifest_path, integrity_kind, integrity, source_byte_length,
          manifest_schema_version, plan_integrity, workspace, agent_config_digest,
          agent_owned_paths_json, status, added_at_ms, updated_at_ms
        ) VALUES (
          'research', 'openclaw.templateInstallRecord.v2', 'package', '@openclaw/research', '1.0.0',
          '/packages/research', '/packages/research/openclaw.template.json', 'artifact',
          'sha256:manifest', 123, 1, 'sha256:plan', '/workspaces/research',
          'sha256:config', '[]', 'complete', 100, 100
        );
        INSERT INTO template_package_refs (
          agent_id, package_kind, package_source, package_ref, package_version,
          package_integrity, schema_version, template_name, package_status,
          relationship, origin, independent_owner, installed_at_ms, updated_at_ms
        ) VALUES (
          'research', 'skill', 'clawhub', '@openclaw/research-skill', '1.0.0',
          'sha256:skill', 'openclaw.templatePackageRef.v1', '@openclaw/research',
          'complete', 'managed', 'template-introduced', 0, 100, 100
        );
        ALTER TABLE template_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE template_installs DROP COLUMN bootstrap_content_digest;
        ALTER TABLE template_package_refs DROP COLUMN extension_id;
        ALTER TABLE template_package_refs DROP COLUMN extension_format;
        ALTER TABLE template_package_refs DROP COLUMN extension_detected_format;
        ALTER TABLE template_package_refs DROP COLUMN extension_mapped_json;
        ALTER TABLE template_package_refs DROP COLUMN extension_unavailable_json;
        ALTER TABLE template_package_refs DROP COLUMN extension_adapter_identity;
      `);

      expect(readTemplateInstallRecordFromDatabase(db, "research")).toMatchObject({
        agentId: "research",
      });
      expect(readTemplateInstallRecordFromDatabase(db, "research")?.bootstrap).toBeUndefined();
      expect(readTemplateInstallRecordsInDatabase(db)).toHaveLength(1);
      expect(
        readTemplatePackageRefsInDatabase(db, { agentId: "research", readOnly: true }),
      ).toEqual([
        expect.objectContaining({
          agentId: "research",
          ref: "@openclaw/research-skill",
          status: "complete",
        }),
      ]);
      expect(readTemplatePackageRefsInDatabase(db)[0]?.extension).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
