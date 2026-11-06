// Defines cron scheduling configuration types.

import type { z } from "zod";
import type { SecretInput } from "./types.secrets.js";
import type { SsrFPolicyConfig } from "./types.ssrf.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

type CronSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.cron>>;

export type CronFailureAlertConfig = NonNullable<CronSchemaInput["failureAlert"]>;

export type CronFailureDestinationConfig = Pick<
  CronFailureAlertConfig,
  "channel" | "to" | "threadId" | "accountId" | "mode"
>;

/** Configured announce destination used when an isolated job names no route of its own. */
export type CronDefaultDeliveryDestinationConfig = NonNullable<CronSchemaInput["delivery"]>;

export type CronConfig = Omit<CronSchemaInput, "webhookToken" | "webhookSsrfPolicy"> & {
  /** Bearer token for cron webhook POST delivery. */
  webhookToken?: SecretInput;
  /** SSRF policy for all outbound cron webhook deliveries. */
  webhookSsrfPolicy?: SsrFPolicyConfig;
};
