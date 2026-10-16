-- Generated v23-to-v24 forward DDL; the owner supplies search_path, transaction, and version publication.

DROP INDEX IF EXISTS idx_task_runs_run_id;
    DROP INDEX IF EXISTS idx_task_runs_status;
    DROP INDEX IF EXISTS idx_task_runs_runtime_status;
    DROP INDEX IF EXISTS idx_task_runs_cleanup_after;
    DROP INDEX IF EXISTS idx_task_runs_last_event_at;
    DROP INDEX IF EXISTS idx_task_runs_owner_key;
    DROP INDEX IF EXISTS idx_task_runs_parent_flow_id;
    DROP INDEX IF EXISTS idx_task_runs_child_session_key;
    DROP INDEX IF EXISTS idx_task_runs_requester_session_key;
    DROP INDEX IF EXISTS idx_task_runs_runtime_source_ended;
    DROP INDEX IF EXISTS idx_task_runs_runtime_ended;

CREATE INDEX "idx_task_runs_runtime_run" ON "task_runs" (("runtime") ASC NULLS FIRST, ("run_id") ASC NULLS FIRST, ("source_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("task_id") ASC NULLS FIRST);

CREATE INDEX "idx_task_runs_cron_runtime_order" ON "task_runs" (("runtime") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("task_id") ASC NULLS FIRST) WHERE ("runtime" = 'cron');

CREATE INDEX "idx_task_runs_cron_source_order" ON "task_runs" (("source_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST, ("task_id") ASC NULLS FIRST) WHERE ("runtime" = 'cron');
