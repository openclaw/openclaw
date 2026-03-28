import { describe, expect, it } from "vitest";
import { parseQueue } from "./queue-parser.js";

describe("parseQueue", () => {
  it("parses full queue with all sections", () => {
    const content = `---
updated: 2026-03-26T14:30:00Z
---

## Available
- TASK-003 [capabilities: code, testing] priority: high
- TASK-005 [capabilities: docs] priority: medium

## Claimed
- TASK-001 [claimed_by: coding-agent-01, since: 2026-03-26T14:00]
- TASK-004 [claimed_by: paralegal-agent, since: 2026-03-26T13:45]

## Done
- TASK-002 [completed: 2026-03-26T12:00, by: coding-agent-01]
`;

    const result = parseQueue(content, "queue.md");

    expect(result.frontmatter).toEqual({ updated: "2026-03-26T14:30:00Z" });

    expect(result.available).toEqual([
      {
        taskId: "TASK-003",
        metadata: { capabilities: "code, testing", priority: "high" },
      },
      {
        taskId: "TASK-005",
        metadata: { capabilities: "docs", priority: "medium" },
      },
    ]);

    expect(result.claimed).toEqual([
      {
        taskId: "TASK-001",
        metadata: {
          claimed_by: "coding-agent-01",
          since: "2026-03-26T14:00",
        },
      },
      {
        taskId: "TASK-004",
        metadata: {
          claimed_by: "paralegal-agent",
          since: "2026-03-26T13:45",
        },
      },
    ]);

    expect(result.done).toEqual([
      {
        taskId: "TASK-002",
        metadata: { completed: "2026-03-26T12:00", by: "coding-agent-01" },
      },
    ]);

    expect(result.blocked).toEqual([]);
  });

  it("returns empty arrays for missing sections", () => {
    const content = `## Available
- TASK-001 [priority: low]
`;
    const result = parseQueue(content, "queue.md");

    expect(result.available).toEqual([{ taskId: "TASK-001", metadata: { priority: "low" } }]);
    expect(result.claimed).toEqual([]);
    expect(result.done).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("handles empty sections", () => {
    const content = `## Available

## Claimed
- TASK-001 [claimed_by: agent-01]
`;
    const result = parseQueue(content, "queue.md");

    expect(result.available).toEqual([]);
    expect(result.claimed).toEqual([{ taskId: "TASK-001", metadata: { claimed_by: "agent-01" } }]);
  });

  it("is case-insensitive for section headings", () => {
    const content = `## available
- TASK-001 [priority: high]

## CLAIMED
- TASK-002 [claimed_by: agent-01]
`;
    const result = parseQueue(content, "queue.md");

    expect(result.available).toHaveLength(1);
    expect(result.available[0].taskId).toBe("TASK-001");
    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0].taskId).toBe("TASK-002");
  });

  it("skips malformed list items", () => {
    const content = `## Available
- not a task reference
- TASK-001 [foo: bar]
- just some text
`;
    const result = parseQueue(content, "queue.md");

    expect(result.available).toEqual([{ taskId: "TASK-001", metadata: { foo: "bar" } }]);
  });

  it("handles no frontmatter", () => {
    const content = `## Available
- TASK-001 [priority: high]
`;
    const result = parseQueue(content, "queue.md");

    expect(result.frontmatter).toBeNull();
    expect(result.available).toHaveLength(1);
  });

  it("parses Blocked section", () => {
    const content = `## Blocked
- TASK-006 [reason: waiting on API]
`;
    const result = parseQueue(content, "queue.md");

    expect(result.blocked).toEqual([
      { taskId: "TASK-006", metadata: { reason: "waiting on API" } },
    ]);
  });

  it("handles trailing key: value pairs outside brackets", () => {
    const content = `## Available
- TASK-003 [capabilities: code] priority: high
`;
    const result = parseQueue(content, "queue.md");

    expect(result.available).toEqual([
      {
        taskId: "TASK-003",
        metadata: { capabilities: "code", priority: "high" },
      },
    ]);
  });
});
