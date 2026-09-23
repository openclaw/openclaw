// Defines command approval configuration types from the canonical schema.
import type { z } from "zod";
import type {
  ApprovalsSchema,
  NativeExecApprovalEnableModeSchema,
} from "./zod-schema.approvals.js";

export type NativeExecApprovalEnableMode = z.input<typeof NativeExecApprovalEnableModeSchema>;

export type ApprovalsConfig = NonNullable<z.input<typeof ApprovalsSchema>>;

export type ExecApprovalForwardingConfig = NonNullable<ApprovalsConfig["exec"]>;

export type ExecApprovalForwardingMode = NonNullable<ExecApprovalForwardingConfig["mode"]>;

export type ExecApprovalForwardTarget = NonNullable<
  ExecApprovalForwardingConfig["targets"]
>[number];
