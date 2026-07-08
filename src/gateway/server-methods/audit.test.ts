import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditHandlers } from "./audit.js";

const listAuditEvents = vi.hoisted(() => vi.fn());

vi.mock("../../audit/audit-event-store.js", () => ({ listAuditEvents }));

async function runAuditHandler(params: Record<string, unknown>) {
  const respond = vi.fn();
  await auditHandlers["audit.list"]({ params, respond } as never);
  return respond;
}

describe("audit.list", () => {
  beforeEach(() => {
    listAuditEvents.mockReset();
    listAuditEvents.mockReturnValue({
      events: [
        {
          eventId: "event-1",
          sequence: 10,
          sourceSequence: 2,
          occurredAt: 100,
          kind: "agent_run",
          action: "agent.run.finished",
          status: "succeeded",
          actorType: "agent",
          actorId: "main",
          agentId: "main",
          runId: "run-1",
          redaction: "metadata_only",
        },
      ],
      nextCursor: 10,
    });
  });

  it("passes bounded filters and maps the public actor shape", async () => {
    const respond = await runAuditHandler({
      agentId: "main",
      kind: "agent_run",
      after: 50,
      before: 150,
      limit: 25,
      cursor: "11",
    });
    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 25,
      cursor: 11,
      filters: { agentId: "main", kind: "agent_run", after: 50, before: 150 },
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        events: [expect.objectContaining({ actor: { type: "agent", id: "main" } })],
        nextCursor: "10",
      }),
    );
  });

  it("rejects malformed cursors and inverted ranges", async () => {
    expect(await runAuditHandler({ cursor: "bad" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.any(Object),
    );
    expect(await runAuditHandler({ after: 2, before: 1 })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.any(Object),
    );
    expect(listAuditEvents).not.toHaveBeenCalled();
  });
});
