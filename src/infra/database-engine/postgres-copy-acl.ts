import type { Client } from "pg";
import { DatabasePortDataError } from "./postgres-store-metadata.js";

// NULL ACLs mean built-in owner privileges, not an empty set. Column and
// schema-local default ACLs instead start empty; global defaults stay in place.
function objects(namespace: string) {
  return `
    SELECT 'SCHEMA' AS kind, '' AS name, '' AS column_name, n.nspowner AS owner,
      COALESCE(n.nspacl, acldefault('n', n.nspowner)) AS acl
    FROM pg_namespace n WHERE n.nspname = ${namespace}
    UNION ALL
    SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      c.relname, '', c.relowner,
      COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${namespace} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    UNION ALL
    SELECT 'COLUMN', c.relname, a.attname, c.relowner, a.attacl
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${namespace} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0 AND NOT a.attisdropped
      -- Compare explicit column rights, not metadata shape; the port catalog owns shape.
      AND a.attacl IS NOT NULL AND cardinality(a.attacl) > 0
    UNION ALL
    SELECT 'DEFAULT', CASE d.defaclobjtype
      WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
      WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' END,
      '', d.defaclrole, d.defaclacl
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = ${namespace} AND cardinality(d.defaclacl) > 0`;
}

function snapshot(namespace: string) {
  return `WITH objects AS (${objects(namespace)})
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'kind', o.kind, 'name', o.name, 'column', o.column_name,
      'owner', pg_get_userbyid(o.owner), 'acl', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantor', pg_get_userbyid(a.grantor),
          'grantee', CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END,
          'privilege', a.privilege_type, 'grantable', a.is_grantable)
          ORDER BY a.grantor, a.grantee, a.privilege_type, a.is_grantable), '[]'::jsonb)
        FROM aclexplode(o.acl) a))
      ORDER BY o.kind, o.name, o.column_name, o.owner), '[]'::jsonb) FROM objects o`;
}

/** Read-only admission; the transaction checks the live catalog again when it copies. */
export async function preflightPostgresCopyAcl(client: Client, namespace: string) {
  const result = await client.query<{ reason: string }>(
    `WITH objects AS (${objects("$1")}), required_roles AS (
      SELECT owner AS oid FROM objects
      UNION SELECT a.grantor FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) a
    )
    SELECT format('SET ROLE %I is required to preserve ownership and ACL grantors. Ask a database administrator to grant that role to %I WITH SET TRUE, then run openclaw update.',
      pg_get_userbyid(r.oid), session_user) AS reason
    FROM required_roles r WHERE NOT pg_has_role(session_user, r.oid, 'SET')
    UNION ALL
    SELECT format('Grantor %I now inherits owner %I, so PostgreSQL would record a different grantor. Ask a database administrator to remove that conflicting inherited ownership or reissue the source grants as the owner, then run openclaw update.',
      pg_get_userbyid(a.grantor), pg_get_userbyid(o.owner))
    FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) a
    WHERE a.grantor <> o.owner AND pg_has_role(a.grantor, o.owner, 'USAGE')
    UNION ALL
    SELECT format('SELECT on %I.%I is required to copy source data. Ask its owner to grant SELECT to %I, then run openclaw update.',
      $1::text, c.relname, current_user)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND (
      (c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT has_table_privilege(c.oid, 'SELECT')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
          AND a.attnum > 0 AND NOT a.attisdropped AND NOT has_column_privilege(c.oid, a.attnum, 'SELECT')))
      OR (c.relkind = 'S' AND NOT has_sequence_privilege(c.oid, 'SELECT')))
    LIMIT 1`,
    [namespace],
  );
  if (result.rows[0]) {
    throw new DatabasePortDataError(
      `Protected PostgreSQL upgrade cannot preserve access rights. ${result.rows[0].reason}`,
    );
  }
}

/** Only the writable c2 clone attaches this SQL, never a frozen backup capture. */
export function postgresCopyAclSql(client: Client, source: string, destination: string) {
  const sourceName = client.escapeLiteral(source);
  const destinationName = client.escapeLiteral(destination);
  // SET ROLE makes PostgreSQL record the original grantor, not the carrier role.
  // Rebuild grants from their dependency graph; never retry a partially granted ACL.
  const body = `DECLARE
    original_role text := current_user;
    source_acl jsonb;
    destination_acl jsonb;
    item jsonb;
    entry jsonb;
    target text;
    grantee text;
    grantor text;
    owner_name text;
    role_name text;
    default_prefix text;
  BEGIN
    source_acl := (${snapshot(sourceName)});
    FOR role_name IN
      SELECT DISTINCT value FROM (
        SELECT x->>'owner' AS value FROM jsonb_array_elements(source_acl) x
        UNION SELECT a->>'grantor' FROM jsonb_array_elements(source_acl) x
          CROSS JOIN LATERAL jsonb_array_elements(x->'acl') a
      ) roles
    LOOP
      IF NOT pg_has_role(session_user, role_name, 'SET') THEN
        RAISE EXCEPTION 'Protected PostgreSQL upgrade requires SET ROLE % to preserve access rights. Ask a database administrator to grant this role WITH SET TRUE, then run openclaw update.', role_name;
      END IF;
      -- Other object owners/grantors need schema lookup during replay. These
      -- temporary rights are removed when the schema ACL is rebuilt last.
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', ${destinationName}, role_name);
    END LOOP;

    -- Creation-time global defaults can add grants absent from the source.
    -- Clear every destination ACL, including owner self-grants, before replay.
    destination_acl := (${snapshot(destinationName)});
    FOR item IN SELECT x FROM jsonb_array_elements(destination_acl) x
      ORDER BY CASE x->>'kind' WHEN 'SCHEMA' THEN 3 WHEN 'COLUMN' THEN 0 ELSE 1 END
    LOOP
      owner_name := item->>'owner';
      EXECUTE format('SET LOCAL ROLE %I', owner_name);
      target := CASE item->>'kind'
        WHEN 'SCHEMA' THEN format('SCHEMA %I', ${destinationName})
        WHEN 'COLUMN' THEN format('TABLE %I.%I', ${destinationName}, item->>'name')
        ELSE format('%s %I.%I', item->>'kind', ${destinationName}, item->>'name') END;
      FOR entry IN SELECT a FROM jsonb_array_elements(item->'acl') a LOOP
        grantee := CASE WHEN entry->>'grantee' IS NULL THEN 'PUBLIC' ELSE quote_ident(entry->>'grantee') END;
        IF item->>'kind' = 'DEFAULT' THEN
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON %s FROM %s CASCADE', owner_name, ${destinationName}, item->>'name', grantee);
        ELSIF item->>'kind' = 'COLUMN' THEN
          EXECUTE format('REVOKE ALL (%I) ON %s FROM %s CASCADE', item->>'column', target, grantee);
        ELSIF item->>'kind' <> 'SCHEMA' THEN
          EXECUTE format('REVOKE ALL ON %s FROM %s CASCADE', target, grantee);
        END IF;
      END LOOP;
      EXECUTE format('SET LOCAL ROLE %I', original_role);
    END LOOP;

    FOR item IN SELECT x FROM jsonb_array_elements(source_acl) x
      ORDER BY CASE x->>'kind' WHEN 'TABLE' THEN 0 WHEN 'SEQUENCE' THEN 1 WHEN 'COLUMN' THEN 2 WHEN 'DEFAULT' THEN 3 ELSE 4 END,
        x->>'name', x->>'column', x->>'owner'
    LOOP
      owner_name := item->>'owner';
      target := CASE item->>'kind'
        WHEN 'SCHEMA' THEN format('SCHEMA %I', ${destinationName})
        WHEN 'COLUMN' THEN format('TABLE %I.%I', ${destinationName}, item->>'name')
        ELSE format('%s %I.%I', item->>'kind', ${destinationName}, item->>'name') END;
      IF item->>'kind' IN ('TABLE', 'SEQUENCE') THEN
        IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${destinationName} AND c.relname = item->>'name'
            AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = owner_name)) THEN
          EXECUTE format('ALTER %s OWNER TO %I', target, owner_name);
        END IF;
      ELSIF item->>'kind' = 'SCHEMA' THEN
        -- Include temporary lookup grants in the final schema reset.
        FOR entry IN SELECT to_jsonb(a) FROM pg_namespace n CROSS JOIN LATERAL
          aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
          WHERE n.nspname = ${destinationName}
        LOOP
          grantee := CASE WHEN entry->>'grantee' = '0' THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid((entry->>'grantee')::oid)) END;
          EXECUTE format('REVOKE ALL ON %s FROM %s CASCADE', target, grantee);
        END LOOP;
      END IF;
      default_prefix := format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I ', owner_name, ${destinationName});
      FOR entry IN
        WITH RECURSIVE grants AS (
          SELECT a FROM jsonb_array_elements(item->'acl') a
        ), roots AS (
          SELECT owner_name AS role_name, a->>'privilege' AS privilege FROM grants
          UNION
          SELECT a->>'grantor', a->>'privilege' FROM grants
          WHERE CASE WHEN item->>'kind' = 'COLUMN' THEN has_column_privilege(
            a->>'grantor', format('%I.%I', ${destinationName}, item->>'name'),
            item->>'column', (a->>'privilege') || ' WITH GRANT OPTION') ELSE false END
        ), paths(role_name, privilege, depth, visited) AS (
          SELECT r.role_name, r.privilege, 0, ARRAY[r.role_name] FROM roots r
          UNION ALL
          SELECT g.a->>'grantee', p.privilege, p.depth + 1, p.visited || (g.a->>'grantee')
          FROM paths p JOIN grants g ON g.a->>'privilege' = p.privilege
            AND pg_has_role(g.a->>'grantor', p.role_name, 'USAGE')
          WHERE (g.a->>'grantable')::boolean AND g.a->>'grantee' IS NOT NULL
            AND NOT (g.a->>'grantee' = ANY(p.visited))
        )
        SELECT g.a FROM grants g ORDER BY
          COALESCE((SELECT min(p.depth) FROM paths p
            WHERE p.privilege = g.a->>'privilege'
              AND pg_has_role(g.a->>'grantor', p.role_name, 'USAGE')), 2147483647),
          g.a->>'grantor', g.a->>'grantee', g.a->>'privilege'
      LOOP
        grantor := entry->>'grantor';
        EXECUTE format('SET LOCAL ROLE %I', grantor);
        grantee := CASE WHEN entry->>'grantee' IS NULL THEN 'PUBLIC' ELSE quote_ident(entry->>'grantee') END;
        IF item->>'kind' = 'DEFAULT' THEN
          EXECUTE default_prefix || format('GRANT %s ON %s TO %s%s', entry->>'privilege', item->>'name', grantee,
            CASE WHEN (entry->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
        ELSE
          EXECUTE format('GRANT %s%s ON %s TO %s%s', entry->>'privilege',
            CASE WHEN item->>'kind' = 'COLUMN' THEN format(' (%I)', item->>'column') ELSE '' END,
            target, grantee, CASE WHEN (entry->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
        END IF;
        EXECUTE format('SET LOCAL ROLE %I', original_role);
      END LOOP;
    END LOOP;
    destination_acl := (${snapshot(destinationName)});
    IF source_acl IS DISTINCT FROM destination_acl THEN
      RAISE EXCEPTION 'Protected PostgreSQL upgrade could not preserve exact ownership, grantors and access rights. Ask a database administrator to check source grant-option chains and SET ROLE privileges, then run openclaw update.';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'Protected PostgreSQL upgrade cannot preserve access rights: %. Ask a database administrator to check SET ROLE and source grant-option privileges, then run openclaw update.', SQLERRM;
  END;`;
  return `DO ${client.escapeLiteral(body)};`;
}
