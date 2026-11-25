// Fixed historical schema: entry-point contracts must not derive fixtures from the current owner.
export const historicalWorkshopChangesSchema = `CREATE TABLE IF NOT EXISTS skill_workshop_changes (
cursor_id INTEGER NOT NULL,
change_id TEXT NOT NULL PRIMARY KEY,
agent_id TEXT NOT NULL,
skill_name TEXT NOT NULL,
action TEXT NOT NULL CHECK (action IN ('create', 'patch', 'write_file', 'remove_file', 'archive', 'restore')),
actor TEXT NOT NULL CHECK (actor IN ('agent', 'review', 'curator', 'user')),
summary TEXT NOT NULL,
version_id TEXT,
session_key TEXT,
run_id TEXT,
created_at_ms INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS skill_workshop_changes_cursor_id_idx
ON skill_workshop_changes(cursor_id);
CREATE INDEX IF NOT EXISTS idx_skill_workshop_changes_agent_time
ON skill_workshop_changes(agent_id, created_at_ms);`;
