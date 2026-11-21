-- Generated v24-to-v25 metadata-only transition; the engine owner publishes openclaw_schema_meta.
-- Subagent operator recovery requires the new reader; catalog and retained rows are unchanged.
UPDATE schema_meta SET schema_version = 25 WHERE meta_key = 'primary' AND schema_version = 24;
UPDATE config_machine_state SET value_json = '25' WHERE state_key = 'state.schema.contentVersion' AND value_json = '24';
