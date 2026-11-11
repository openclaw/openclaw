import { postgresVectorDecoderSql } from "../infra/database-engine/postgres-search-schema.js";

// Resolve the existing return type so extension namespaces and absent optional vectors survive.
export const AGENT_VECTOR_DECODER_POSTGRES_SQL = `DO $migration$
DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_type t ON t.oid = p.prorettype
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE p.oid = to_regprocedure(format('%I.openclaw_vector(bytea,integer)', current_schema()));
  IF FOUND THEN
    EXECUTE replace($decoder$${postgresVectorDecoderSql("__vector_extension__", 2, true)}$decoder$,
      '__vector_extension__', replace(extension_schema, '"', '""'));
  END IF;
END $migration$;`;
