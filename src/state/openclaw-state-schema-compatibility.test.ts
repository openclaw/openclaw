import { describe, expect, it } from "vitest";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";

describe("OpenClaw state runtime schema projection", () => {
  it.each([false, true])(
    "preserves first-use exclusions with version-lazy tables enabled: %s",
    (includeVersionLazyAdditiveTables) => {
      const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables });

      expect(schema.includes("CREATE TABLE IF NOT EXISTS cron_run_receipts")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("CREATE TABLE IF NOT EXISTS worker_session_placement_moves")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("idx_cron_run_receipts_active_job")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("idx_cron_run_receipts_job_history")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_progress");
      expect(schema).not.toContain(
        "CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings",
      );
      expect(schema).not.toContain("outbound_message_execution_bindings_execution_event_idx");
      expect(schema).not.toContain("outbound_message_progress_occurred_idx");
      expect(schema).not.toContain("outbound_message_progress_run_occurred_idx");
      expect(schema.includes("CREATE TABLE IF NOT EXISTS github_publication_requests")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("idx_github_publication_requests_pending")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("CREATE TABLE IF NOT EXISTS config_revision_keys")).toBe(
        includeVersionLazyAdditiveTables,
      );
    },
  );
});
