import type { DatabaseSync } from "node:sqlite";
import {
  LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES,
  LEGACY_ENTRY_VALIDITY_TRIGGERS_SQL,
} from "./openclaw-agent-schema-history.js";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export { LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES } from "./openclaw-agent-schema-history.js";

/** Legacy shape repair precedes the historical schema assertion during offline migration. */
export function ensureLegacySessionEntryValidityTriggers(db: DatabaseSync): void {
  db.exec(LEGACY_ENTRY_VALIDITY_TRIGGERS_SQL);
}

/** The offline schema owner retires raw-writer tracking before publishing schema 25. */
export function migrateCanonicalSessionWriterValidation(db: DatabaseSync): void {
  for (const name of LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  ensureColumn(db, "session_key_contract", "canonical_ready TEXT");
  // A clean old receipt cannot certify imported rows under the new writer contract.
  db.exec(`
    INSERT INTO session_canonical_validation_pending (session_key)
    SELECT session_key FROM session_nodes WHERE true
    ON CONFLICT (session_key) DO NOTHING;
    UPDATE session_key_contract SET canonical_ready = NULL WHERE id = 1;
  `);
}

export function seedCanonicalSessionValidationPending(db: DatabaseSync): void {
  // Migration records work only; the canonical owner validates and certifies row contents.
  db.exec(`
    INSERT INTO session_canonical_validation_pending (session_key)
    SELECT node.session_key FROM session_nodes AS node
    WHERE NOT EXISTS (
      SELECT 1 FROM session_canonical_validation_pending AS pending
      WHERE pending.session_key = node.session_key
    );
  `);
}
