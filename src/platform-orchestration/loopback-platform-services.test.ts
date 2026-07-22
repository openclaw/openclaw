import type { StartExecutionCommand } from "@openclaw/contracts";
import { describe, expect, it, vi } from "vitest";
import { LoopbackPiExecutionAdapter } from "./loopback-platform-services.js";

const timestamp = "2026-07-18T12:00:00.000Z";
const messageId = "msg_018f0000-0000-7000-8000-000000000001";
const projectId = "prj_018f0000-0000-7000-8000-000000000002";
const jobId = "job_018f0000-0000-7000-8000-000000000003";
const executionId = "exe_018f0000-0000-7000-8000-000000000004";

function command(): StartExecutionCommand {
  return {
    schema_version: "1.0.0",
    message_id: messageId,
    correlation_id: messageId,
    occurred_at: timestamp,
    project_id: projectId,
    job_id: jobId,
    git_repository_id: "git_018f0000-0000-7000-8000-000000000005",
    base_commit_sha: "1".repeat(40),
    task: "Run the execution",
  };
}

describe("loopback platform service adapters", () => {
  it("uses bearer auth, idempotency, and validated terminal events", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schema_version: "1.0.0",
            message_id: messageId,
            correlation_id: messageId,
            project_id: projectId,
            job_id: jobId,
            execution_id: executionId,
            status: "queued",
            accepted_at: timestamp,
          }),
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            "id: 2",
            "event: execution_completed",
            `data: ${JSON.stringify({
              schema_version: "1.0.0",
              message_id: messageId,
              correlation_id: messageId,
              causation_id: messageId,
              occurred_at: timestamp,
              project_id: projectId,
              job_id: jobId,
              execution_id: executionId,
              worktree_id: "wtr_018f0000-0000-7000-8000-000000000006",
              commit_sha: "2".repeat(40),
              branch_name: "pi/job",
              artifact_ids: [],
              evidence_ids: [],
              summary: "Passed",
            })}`,
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const adapter = new LoopbackPiExecutionAdapter({
      baseUrl: "http://127.0.0.1:4123",
      bearerToken: "test-bearer-token",
      fetch,
      sleep: async () => {},
    });

    const accepted = await adapter.start(command(), "job:execution:1");
    const completed = await adapter.wait(accepted.execution_id);

    expect(completed).toMatchObject({ execution_id: executionId, commit_sha: "2".repeat(40) });
    const firstCall = fetch.mock.calls.at(0);
    expect(firstCall).toBeDefined();
    const firstInit = firstCall?.[1];
    const firstHeaders = new Headers(firstInit?.headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer test-bearer-token");
    expect(firstHeaders.get("idempotency-key")).toBe("job:execution:1");
    expect(fetch.mock.calls.at(1)?.[0]).toEqual(
      new URL(`http://127.0.0.1:4123/v1/executions/${executionId}/events`),
    );
  });

  it("rejects non-loopback origins before sending credentials", () => {
    expect(
      () =>
        new LoopbackPiExecutionAdapter({
          baseUrl: "https://example.com",
          bearerToken: "must-not-leak",
        }),
    ).toThrow("bare HTTP loopback origin");
  });

  it("does not include the bearer token in request failures", async () => {
    const token = "highly-sensitive-bearer-token";
    const adapter = new LoopbackPiExecutionAdapter({
      baseUrl: "http://127.0.0.1:4123",
      bearerToken: token,
      fetch: vi.fn(async () => {
        throw new Error(token);
      }),
    });

    await expect(adapter.start(command(), "job:execution:1")).rejects.not.toThrow(token);
  });
});
