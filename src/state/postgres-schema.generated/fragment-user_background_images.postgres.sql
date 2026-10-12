-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."user_background_images" (
  "profile_id" text COLLATE "C" NOT NULL,
  "asset_id" text COLLATE "C" NOT NULL,
  "image" bytea NOT NULL,
  "width" bigint NOT NULL,
  "height" bigint NOT NULL,
  PRIMARY KEY ("profile_id"),
  CHECK ((octet_length("image") BETWEEN 1 AND 2097152)),
  CHECK (("width" BETWEEN 1 AND 2560)),
  CHECK (("height" BETWEEN 1 AND 2560)),
  UNIQUE ("asset_id")
);

ALTER TABLE "openclaw_state"."user_background_images" ADD FOREIGN KEY ("profile_id") REFERENCES "openclaw_state"."user_profiles" ("id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
