// Tests session reset prompt generation and transcript-preserving restart hints.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { resolveBareSessionResetPromptState } from "./session-reset-prompt.js";

type ResetPromptParams = Parameters<typeof resolveBareSessionResetPromptState>[0];

async function resolveResetPrompt(params: ResetPromptParams = {}): Promise<string> {
  return (await resolveBareSessionResetPromptState(params)).prompt;
}

async function makeBootstrapPendingWorkspace(): Promise<string> {
  const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-");
  await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");
  return workspaceDir;
}

describe("resolveBareSessionResetPromptState", () => {
  it("includes the explicit Session Startup instruction for bare /new and /reset", async () => {
    const prompt = await resolveResetPrompt();
    expect(prompt).toContain("Execute your Session Startup sequence now");
    expect(prompt).toContain("read the required files before responding to the user");
    expect(prompt).toContain("If BOOTSTRAP.md exists in the provided Project Context");
    expect(prompt).toContain("read it and follow its instructions first");
    expect(prompt).not.toContain(
      "If runtime-provided startup context is included for this first turn",
    );
  });

  it("resolves shared bare reset prompt state from workspace bootstrap truth", async () => {
    const workspaceDir = await makeBootstrapPendingWorkspace();

    const pending = await resolveBareSessionResetPromptState({ workspaceDir });
    expect(pending.bootstrapMode).toBe("full");
    expect(pending.shouldPrependStartupContext).toBe(false);
    expect(pending.prompt).toContain("while bootstrap is still pending for this workspace");

    await fs.unlink(path.join(workspaceDir, "BOOTSTRAP.md"));

    const complete = await resolveBareSessionResetPromptState({ workspaceDir });
    expect(complete.bootstrapMode).toBe("none");
    expect(complete.shouldPrependStartupContext).toBe(true);
    expect(complete.prompt).toContain("Execute your Session Startup sequence now");
  });

  it("awaits async bootstrap file access before selecting reset mode", async () => {
    const workspaceDir = await makeBootstrapPendingWorkspace();
    const hasBootstrapFileAccess = vi.fn(async () => false);

    const pending = await resolveBareSessionResetPromptState({
      workspaceDir,
      hasBootstrapFileAccess,
    });

    expect(hasBootstrapFileAccess).toHaveBeenCalledTimes(1);
    expect(pending.bootstrapMode).toBe("limited");
    expect(pending.shouldPrependStartupContext).toBe(false);
  });
});
