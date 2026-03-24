import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedContextFile } from "../../agents/pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";
const hoisted = vi.hoisted(() => ({
  resolveBootstrapContextForRun: vi.fn(),
  buildWorkspaceHookSnapshot: vi.fn(),
}));

vi.mock("../../agents/bootstrap-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/bootstrap-files.js")>(
    "../../agents/bootstrap-files.js",
  );
  return {
    ...actual,
    resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRun,
  };
});

vi.mock("../../hooks/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/workspace.js")>(
    "../../hooks/workspace.js",
  );
  return {
    ...actual,
    buildWorkspaceHookSnapshot: hoisted.buildWorkspaceHookSnapshot,
  };
});

import { hasPromptAffectingBootstrapHooks } from "./bootstrap-prompt-hooks.js";
import {
  buildBareSessionResetPrompt,
  buildBareSessionResetPromptForRun,
  resolveBareSessionResetPromptMode,
} from "./session-reset-prompt.js";

function makeBootstrapFile(
  overrides: Partial<WorkspaceBootstrapFile> = {},
): WorkspaceBootstrapFile {
  return {
    name: "AGENTS.md",
    path: "/tmp/AGENTS.md",
    content: "## Session Startup\n\nRead AGENTS.md.",
    missing: false,
    ...overrides,
  };
}

function makeInjectedFile(
  content: string,
  overrides: Partial<EmbeddedContextFile> = {},
): EmbeddedContextFile {
  return {
    path: "/tmp/AGENTS.md",
    content,
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.resolveBootstrapContextForRun.mockReset();
  hoisted.buildWorkspaceHookSnapshot.mockReset();
  hoisted.buildWorkspaceHookSnapshot.mockReturnValue({
    hooks: [],
    resolvedHooks: [],
  });
});

describe("buildBareSessionResetPrompt", () => {
  it("keeps the sync fallback generic when bootstrap state is unavailable", () => {
    const prompt = buildBareSessionResetPrompt();
    expect(prompt).toContain("Run your Session Startup sequence");
    expect(prompt).toContain("Read the required bootstrap/reference files before responding");
    expect(prompt).not.toContain("Use injected workspace bootstrap/reference files already");
    expect(prompt).not.toContain("new-prompt.mjs");
  });

  it("appends current time line so agents know the date", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(cfg, nowMs);
    expect(prompt).toContain(
      "Current time: Tuesday, March 3rd, 2026 — 9:00 AM (America/New_York) / 2026-03-03 14:00 UTC",
    );
  });

  it("does not append a duplicate current time line", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("falls back to UTC when no timezone configured", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect(prompt).toContain("Current time:");
  });
});

describe("resolveBareSessionResetPromptMode", () => {
  it("uses generic mode when there is no usable injected bootstrap content", () => {
    expect(
      resolveBareSessionResetPromptMode({
        bootstrapFiles: [makeBootstrapFile({ missing: true, content: undefined })],
        injectedFiles: [makeInjectedFile("[MISSING] Expected at: /tmp/AGENTS.md")],
      }),
    ).toBe("generic");
  });

  it("uses injected mode when bootstrap content is fully injected", () => {
    const content = "## Session Startup\n\nRead AGENTS.md.";
    expect(
      resolveBareSessionResetPromptMode({
        bootstrapFiles: [makeBootstrapFile({ content })],
        injectedFiles: [makeInjectedFile(content)],
      }),
    ).toBe("injected");
  });

  it("uses truncated mode when bootstrap content is only partially injected", () => {
    const content = "## Session Startup\n\n" + "A".repeat(200);
    expect(
      resolveBareSessionResetPromptMode({
        bootstrapFiles: [makeBootstrapFile({ content })],
        injectedFiles: [makeInjectedFile(content.slice(0, 40))],
      }),
    ).toBe("truncated");
  });

  it("uses truncated mode when injected content carries a truncation marker", () => {
    const content = "tiny";
    expect(
      resolveBareSessionResetPromptMode({
        bootstrapFiles: [makeBootstrapFile({ content })],
        injectedFiles: [makeInjectedFile("tiny with marker", { truncated: true })],
      }),
    ).toBe("truncated");
  });
});

describe("buildBareSessionResetPromptForRun", () => {
  it("treats unconfigured bundled bootstrap-extra-files as non-blocking", () => {
    hoisted.buildWorkspaceHookSnapshot.mockReturnValueOnce({
      hooks: [{ name: "bootstrap-extra-files", events: ["agent:bootstrap"] }],
      resolvedHooks: [
        {
          name: "bootstrap-extra-files",
          source: "openclaw-bundled",
        },
      ],
    });

    expect(
      hasPromptAffectingBootstrapHooks({
        workspaceDir: "/tmp/workspace",
        cfg: { hooks: { internal: { enabled: true } } },
      }),
    ).toBe(false);
  });

  it("treats configured bundled bootstrap-extra-files as prompt-affecting", () => {
    hoisted.buildWorkspaceHookSnapshot.mockReturnValueOnce({
      hooks: [{ name: "bootstrap-extra-files", events: ["agent:bootstrap"] }],
      resolvedHooks: [
        {
          name: "bootstrap-extra-files",
          source: "openclaw-bundled",
        },
      ],
    });

    expect(
      hasPromptAffectingBootstrapHooks({
        workspaceDir: "/tmp/workspace",
        cfg: {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "bootstrap-extra-files": {
                  paths: ["packages/*/AGENTS.md"],
                },
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("skips preflight bootstrap resolution when another bootstrap hook is active", async () => {
    hoisted.buildWorkspaceHookSnapshot.mockReturnValueOnce({
      hooks: [{ name: "custom-bootstrap", events: ["agent:bootstrap"] }],
      resolvedHooks: [
        {
          name: "custom-bootstrap",
          source: "openclaw-managed",
        },
      ],
    });

    const prompt = await buildBareSessionResetPromptForRun({
      workspaceDir: "/tmp/workspace",
      cfg: { hooks: { internal: { enabled: true } } },
    });

    expect(prompt).toContain("Read the required bootstrap/reference files before responding");
    expect(hoisted.resolveBootstrapContextForRun).not.toHaveBeenCalled();
  });

  it("falls back to the generic prompt when bootstrap resolution fails", async () => {
    hoisted.resolveBootstrapContextForRun.mockRejectedValueOnce(new Error("boom"));

    const prompt = await buildBareSessionResetPromptForRun({
      workspaceDir: "/tmp/workspace",
    });

    expect(prompt).toContain("Read the required bootstrap/reference files before responding");
    expect(prompt).not.toContain("Use injected workspace bootstrap/reference files already");
  });
});
