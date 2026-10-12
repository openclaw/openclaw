import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { noteSandboxScopeWarnings } from "./doctor-sandbox.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

describe("noteSandboxScopeWarnings", () => {
  beforeEach(() => {
    vi.mocked(note).mockClear();
  });

  it("identifies ignored canonical agent overrides under inherited shared scope", () => {
    noteSandboxScopeWarnings({
      agents: {
        defaults: { sandbox: { scope: "shared" } },
        entries: {
          work: {
            sandbox: {
              docker: { setupCommand: "echo work" },
              browser: { enabled: true },
              prune: { idleHours: 1 },
            },
          },
        },
      },
    });

    expect(note).toHaveBeenCalledExactlyOnceWith(
      '- agents.entries.work sandbox docker/browser/prune overrides ignored.\n  scope resolves to "shared".',
      "Sandbox",
    );
  });

  it.each(["agent", "session"] as const)(
    "does not warn when the agent overrides shared scope with %s scope",
    (scope) => {
      noteSandboxScopeWarnings({
        agents: {
          defaults: { sandbox: { scope: "shared" } },
          entries: { work: { sandbox: { scope, docker: { setupCommand: "echo work" } } } },
        },
      });

      expect(note).not.toHaveBeenCalled();
    },
  );

  it("does not warn for empty overrides under shared scope", () => {
    noteSandboxScopeWarnings({
      agents: {
        defaults: { sandbox: { scope: "shared", docker: { setupCommand: "echo shared" } } },
        entries: { work: { sandbox: { docker: {}, browser: {}, prune: {} } } },
      },
    });

    expect(note).not.toHaveBeenCalled();
  });
});
