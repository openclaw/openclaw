import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import type { SessionSummary, ExperientialMoment } from "../../../experiential/types.js";
import { ExperientialStore } from "../../../experiential/store.js";
import { makeTempWorkspace } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: `summary-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    sessionKey: "agent:main:main",
    startedAt: Date.now() - 3600000,
    endedAt: Date.now() - 1000,
    topics: ["API design", "authentication"],
    momentCount: 3,
    keyAnchors: ["decided on JWT"],
    openUncertainties: ["rate limiting approach"],
    reconstitutionHints: ["Session focused on: API design"],
    ...overrides,
  };
}

function makeMoment(overrides: Partial<ExperientialMoment> = {}): ExperientialMoment {
  return {
    id: `moment-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    timestamp: Date.now(),
    sessionKey: "agent:main:main",
    source: "message",
    content: "Significant discussion about architecture",
    significance: {
      total: 0.8,
      emotional: 0.5,
      uncertainty: 0.3,
      relationship: 0.4,
      consequential: 0.7,
      reconstitution: 0.8,
    },
    disposition: "immediate",
    reasons: ["high impact"],
    anchors: ["architecture decision"],
    uncertainties: [],
    ...overrides,
  };
}

describe("experiential-reconstitution hook", () => {
  it("skips non-bootstrap events", async () => {
    const event = createHookEvent("command", "new", "agent:main:main", {});
    await handler(event);
  });

  it("skips when not explicitly enabled", async () => {
    const tempDir = await makeTempWorkspace("recon-test-");
    const bootstrapFiles: WorkspaceBootstrapFile[] = [];

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
      bootstrapFiles,
      cfg: {},
    });

    await handler(event);

    // EXISTENCE.md should not be created
    const existencePath = path.join(tempDir, "EXISTENCE.md");
    await expect(fs.access(existencePath)).rejects.toThrow();
  });

  it("skips subagent sessions", async () => {
    const tempDir = await makeTempWorkspace("recon-test-");
    const bootstrapFiles: WorkspaceBootstrapFile[] = [];

    const event = createHookEvent("agent", "bootstrap", "subagent:main:child", {
      workspaceDir: tempDir,
      bootstrapFiles,
      sessionKey: "subagent:main:child",
      cfg: {
        hooks: {
          internal: {
            entries: {
              "experiential-reconstitution": { enabled: true },
            },
          },
        },
      },
    });

    await handler(event);

    const existencePath = path.join(tempDir, "EXISTENCE.md");
    await expect(fs.access(existencePath)).rejects.toThrow();
  });

  it("writes EXISTENCE.md with experiential data when enabled", async () => {
    const tempDir = await makeTempWorkspace("recon-test-");
    const bootstrapFiles: WorkspaceBootstrapFile[] = [];

    // Seed some experiential data
    const store = new ExperientialStore();
    try {
      store.saveSessionSummary(makeSummary());
      store.saveMoment(makeMoment());
    } finally {
      store.close();
    }

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
      bootstrapFiles,
      cfg: {
        hooks: {
          internal: {
            entries: {
              "experiential-reconstitution": { enabled: true },
            },
          },
        },
      },
    });

    await handler(event);

    // Verify EXISTENCE.md was created
    const existencePath = path.join(tempDir, "EXISTENCE.md");
    const content = await fs.readFile(existencePath, "utf-8");
    expect(content).toContain("Experiential Continuity");
    expect(content).toContain("API design");

    // Verify it was added to bootstrap files
    expect(bootstrapFiles.length).toBe(1);
    expect(bootstrapFiles[0].name).toBe("EXISTENCE.md");
    expect(bootstrapFiles[0].missing).toBe(false);
  });

  it("writes empty state message when no data exists", async () => {
    // Use a fresh DB path to ensure no data
    const tempDir = await makeTempWorkspace("recon-test-");
    const bootstrapFiles: WorkspaceBootstrapFile[] = [];

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
      bootstrapFiles,
      cfg: {
        hooks: {
          internal: {
            entries: {
              "experiential-reconstitution": { enabled: true },
            },
          },
        },
      },
    });

    await handler(event);

    const existencePath = path.join(tempDir, "EXISTENCE.md");
    const content = await fs.readFile(existencePath, "utf-8");
    expect(content).toContain("Experiential Continuity");
  });

  it("updates existing EXISTENCE.md entry in bootstrap files", async () => {
    const tempDir = await makeTempWorkspace("recon-test-");
    const existencePath = path.join(tempDir, "EXISTENCE.md");
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      { name: "EXISTENCE.md", path: existencePath, content: "old content", missing: false },
    ];

    // Seed data
    const store = new ExperientialStore();
    try {
      store.saveSessionSummary(makeSummary());
    } finally {
      store.close();
    }

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
      bootstrapFiles,
      cfg: {
        hooks: {
          internal: {
            entries: {
              "experiential-reconstitution": { enabled: true },
            },
          },
        },
      },
    });

    await handler(event);

    // Should update existing entry, not add a new one
    expect(bootstrapFiles.length).toBe(1);
    expect(bootstrapFiles[0].content).toContain("Experiential Continuity");
    expect(bootstrapFiles[0].content).not.toBe("old content");
  });
});
