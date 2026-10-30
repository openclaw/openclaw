-- Generated DDL-only v34-to-v35 transition; reconciliation converts retained rows online.
DO $workspace_cas$ BEGIN
IF to_regclass('local_workspace_projections') IS NOT NULL THEN
ALTER TABLE "local_workspace_projections" ADD COLUMN "tree_root_digest" bytea;
ALTER TABLE "local_workspace_projections" ADD COLUMN "source_paths_digest" bytea;
ALTER TABLE "local_workspace_projections" ADD COLUMN "canonical_fingerprints" bytea;
ALTER TABLE "local_workspace_projections" ADD COLUMN "projection_fingerprints" bytea;
CREATE TABLE "local_workspace_source_path_sets" (
  "path_digest" bytea NOT NULL,
  "paths_zstd" bytea NOT NULL,
  "sweep_epoch" bigint NOT NULL,
  PRIMARY KEY ("path_digest"),
  CHECK ((octet_length("path_digest") = 32))
);
CREATE TABLE "local_workspace_tree_packs" (
  "tree_digest" bytea NOT NULL,
  "records_json" text COLLATE "C" NOT NULL,
  "children_json" text COLLATE "C" NOT NULL,
  "sweep_epoch" bigint NOT NULL,
  PRIMARY KEY ("tree_digest"),
  CHECK ((octet_length("tree_digest") = 32))
);
END IF; END $workspace_cas$;
