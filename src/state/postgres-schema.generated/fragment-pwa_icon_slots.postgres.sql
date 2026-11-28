-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "pwa_icon_slots" (
  "profile_key" text COLLATE "C" NOT NULL,
  "device_key" text COLLATE "C" NOT NULL,
  "token" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("profile_key", "device_key"),
  CHECK ((char_length("token") = 64)),
  UNIQUE ("token")
);
