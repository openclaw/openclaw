-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "user_preferences" (
  "profile_id" text COLLATE "C" NOT NULL,
  "pref_key" text COLLATE "C" NOT NULL,
  "value_json" text COLLATE "C" NOT NULL,
  "updated_at_ms" bigint NOT NULL,
  PRIMARY KEY ("profile_id", "pref_key")
);
