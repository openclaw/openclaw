// Work command tests cover the Beads-backed orchestration CLI behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BeadsClient, BeadsIssue } from "../work-tracking/beads.js";
import {
  workCloseCommand,
  workCreateCommand,
  workListCommand,
  workReadyCommand,
  workShowCommand,
} from "./work.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
};

const sampleIssue: BeadsIssue = {
  id: "bd-123",
  issue_type: "task",
  metadata: { branch: "klaw/beads-work-tracking", repo: "openclaw/openclaw" },
  priority: 1,
  status: "open",
  title: "Add Beads work tracking",
};

function createMockClient(): BeadsClient {
  return {
    status: vi.fn(async () => ({ ok: true })),
    ready: vi.fn(async () => [sampleIssue]),
    list: vi.fn(async () => [sampleIssue]),
    show: vi.fn(async () => sampleIssue),
    create: vi.fn(async () => sampleIssue),
    claim: vi.fn(async () => sampleIssue),
    close: vi.fn(async () => ({ closed: true })),
  };
}

describe("work commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates Beads work with repo, branch, PR, next action, and dependency metadata", async () => {
    const client = createMockClient();

    await workCreateCommand(
      {
        title: "Add Beads work tracking",
        json: true,
        type: "task",
        priority: "P1",
        label: ["openclaw", "klaw"],
        metadata: ["source=agent"],
        repo: "openclaw/openclaw",
        branch: "klaw/beads-work-tracking",
        prUrl: "https://github.com/openclaw/openclaw/pull/123",
        nextAction: "review",
        dependsOn: ["bd-parent"],
        discoveredFrom: ["bd-discovery"],
      },
      runtime,
      { client },
    );

    expect(client.create).toHaveBeenCalledWith({
      title: "Add Beads work tracking",
      type: "task",
      priority: "P1",
      labels: ["openclaw", "klaw"],
      metadata: {
        branch: "klaw/beads-work-tracking",
        nextAction: "review",
        prUrl: "https://github.com/openclaw/openclaw/pull/123",
        repo: "openclaw/openclaw",
        source: "agent",
      },
      description: undefined,
      externalRef: "https://github.com/openclaw/openclaw/pull/123",
      dependencies: ["blocks:bd-parent", "discovered-from:bd-discovery"],
    });
    expect(runtime.writeJson).toHaveBeenCalledWith({ work: sampleIssue }, 2);
  });

  it("lists ready work through Beads ready instead of task ledger state", async () => {
    const client = createMockClient();

    await workReadyCommand(
      {
        json: true,
        limit: 25,
        label: ["openclaw"],
        metadata: ["repo=openclaw/openclaw"],
      },
      runtime,
      { client },
    );

    expect(client.ready).toHaveBeenCalledWith({
      limit: 25,
      labels: ["openclaw"],
      metadata: { repo: "openclaw/openclaw" },
    });
    expect(runtime.writeJson).toHaveBeenCalledWith({ count: 1, work: [sampleIssue] }, 2);
  });

  it("lists Beads work with status and all filters", async () => {
    const client = createMockClient();

    await workListCommand(
      {
        json: true,
        status: "in_progress",
        all: true,
      },
      runtime,
      { client },
    );

    expect(client.list).toHaveBeenCalledWith({
      all: true,
      labels: undefined,
      limit: undefined,
      metadata: {},
      status: "in_progress",
    });
  });

  it("shows and closes Beads work items", async () => {
    const client = createMockClient();

    await workShowCommand({ id: "bd-123", json: true }, runtime, { client });
    await workCloseCommand({ id: "bd-123", reason: "merged", json: true }, runtime, { client });

    expect(client.show).toHaveBeenCalledWith("bd-123");
    expect(client.close).toHaveBeenCalledWith("bd-123", { reason: "merged" });
  });
});
