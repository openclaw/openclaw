// Beads bridge tests cover command construction and metadata parsing.
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenClawWorkMetadata,
  createBeadsClient,
  parseBeadsMetadataFilters,
} from "./beads.js";

describe("Beads work graph client", () => {
  it("parses exact-match metadata filters", () => {
    expect(
      parseBeadsMetadataFilters(["repo=openclaw/openclaw", "priority=2", "active=true"]),
    ).toEqual({
      active: true,
      priority: 2,
      repo: "openclaw/openclaw",
    });
  });

  it("builds OpenClaw orchestration metadata without a custom projection store", () => {
    expect(
      buildOpenClawWorkMetadata({
        metadata: { source: "agent" },
        repo: "openclaw/openclaw",
        branch: "klaw/beads-work-tracking",
        prUrl: "https://github.com/openclaw/openclaw/pull/123",
        owner: "klaw",
        nextAction: "review ready work",
      }),
    ).toEqual({
      branch: "klaw/beads-work-tracking",
      nextAction: "review ready work",
      owner: "klaw",
      prUrl: "https://github.com/openclaw/openclaw/pull/123",
      repo: "openclaw/openclaw",
      source: "agent",
    });
  });

  it("creates Beads work with labels, metadata, external refs, and dependencies", async () => {
    const runner = vi.fn(async () => ({
      stderr: "",
      stdout: JSON.stringify({ id: "bd-123", title: "Ship Beads bridge" }),
    }));
    const client = createBeadsClient(runner);

    await client.create({
      title: "Ship Beads bridge",
      type: "task",
      priority: "P1",
      labels: ["openclaw", "klaw"],
      metadata: {
        repo: "openclaw/openclaw",
        prUrl: "https://github.com/openclaw/openclaw/pull/123",
      },
      externalRef: "gh-123",
      dependencies: ["blocks:bd-parent", "discovered-from:bd-source"],
    });

    expect(runner).toHaveBeenCalledWith([
      "create",
      "Ship Beads bridge",
      "--type",
      "task",
      "--priority",
      "P1",
      "--labels",
      "openclaw",
      "--labels",
      "klaw",
      "--external-ref",
      "gh-123",
      "--deps",
      "blocks:bd-parent,discovered-from:bd-source",
      "--metadata",
      JSON.stringify({
        repo: "openclaw/openclaw",
        prUrl: "https://github.com/openclaw/openclaw/pull/123",
      }),
      "--json",
    ]);
  });

  it("asks Beads for ready work using dependency-aware filters", async () => {
    const runner = vi.fn(async () => ({
      stderr: "",
      stdout: JSON.stringify([{ id: "bd-ready", title: "Ready item" }]),
    }));
    const client = createBeadsClient(runner);

    await expect(
      client.ready({
        limit: 10,
        labels: ["openclaw"],
        metadata: { repo: "openclaw/openclaw" },
      }),
    ).resolves.toEqual([{ id: "bd-ready", title: "Ready item" }]);

    expect(runner).toHaveBeenCalledWith([
      "ready",
      "--limit",
      "10",
      "--label",
      "openclaw",
      "--metadata-field",
      "repo=openclaw/openclaw",
      "--json",
    ]);
  });
});
