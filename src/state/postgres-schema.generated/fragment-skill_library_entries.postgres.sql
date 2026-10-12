-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."skill_library_entries" (
  "skill_id" text COLLATE "C" NOT NULL,
  "owner_profile_id" text COLLATE "C",
  "author_profile_id" text COLLATE "C" NOT NULL,
  "slug" text COLLATE "C" NOT NULL,
  "current_revision" text COLLATE "C" NOT NULL,
  "shared" bigint NOT NULL,
  "enabled" bigint NOT NULL,
  "removed" bigint NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("skill_id")
);

CREATE TABLE "openclaw_state"."skill_library_events" (
  "event_id" text COLLATE "C" NOT NULL,
  "skill_id" text COLLATE "C" NOT NULL,
  "revision" text COLLATE "C" NOT NULL,
  "action" text COLLATE "C" NOT NULL,
  "actor_profile_id" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("event_id")
);

CREATE TABLE "openclaw_state"."skill_library_revisions" (
  "skill_id" text COLLATE "C" NOT NULL,
  "revision" text COLLATE "C" NOT NULL,
  "description" text COLLATE "C" NOT NULL,
  "files_json" text COLLATE "C" NOT NULL,
  "created_at" bigint NOT NULL,
  PRIMARY KEY ("skill_id", "revision")
);

CREATE TABLE "openclaw_state"."skill_library_uploads" (
  "upload_id" text COLLATE "C" NOT NULL,
  "owner_profile_id" text COLLATE "C" NOT NULL,
  "slug" text COLLATE "C" NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text COLLATE "C" NOT NULL,
  "archive_blob" bytea NOT NULL,
  "expires_at" bigint NOT NULL,
  "published_skill_id" text COLLATE "C",
  PRIMARY KEY ("upload_id")
);

COMMIT;
