-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."web_push_approval_deliveries" (
  "approval_id" text COLLATE "C" NOT NULL,
  "subscription_id" text COLLATE "C" NOT NULL,
  "device_id" text COLLATE "C" NOT NULL,
  "user_profile_id" text COLLATE "C",
  "prepared_at_ms" bigint NOT NULL,
  PRIMARY KEY ("approval_id", "subscription_id")
);

CREATE INDEX "idx_web_push_approval_deliveries_subscription" ON "openclaw_state"."web_push_approval_deliveries" (("subscription_id") ASC NULLS FIRST, ("approval_id") ASC NULLS FIRST);

ALTER TABLE "openclaw_state"."web_push_approval_deliveries" ADD FOREIGN KEY ("subscription_id") REFERENCES "openclaw_state"."web_push_subscriptions" ("subscription_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

ALTER TABLE "openclaw_state"."web_push_approval_deliveries" ADD FOREIGN KEY ("approval_id") REFERENCES "openclaw_state"."operator_approvals" ("approval_id") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE;

COMMIT;
