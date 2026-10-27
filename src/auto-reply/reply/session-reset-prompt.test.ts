import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { resolveBareSessionResetPromptState } from "./session-reset-prompt.js";

async function makeBootstrapPendingWorkspace(): Promise<string> {
  const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-");
  await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");
  return workspaceDir;
}

it("includes the explicit Session Startup instruction for bare /new and /reset", async () => {
  const cfg = {
    agents: { defaults: { userTimezone: "America/New_York" } },
  } satisfies OpenClawConfig;
  using _ = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 2, 3, 14));
  const { prompt } = await resolveBareSessionResetPromptState({ cfg });
  expect(prompt).toContain("Current time: Tuesday, March 3rd, 2026 - 9:00 AM (America/New_York)");
  expect(prompt).toContain("Reference UTC: 2026-03-03 14:00 UTC");
  expect(prompt).toContain("Execute your Session Startup sequence now");
  expect(prompt).toContain("read the required files before responding to the user");
  expect(prompt).toContain("If BOOTSTRAP.md exists in the provided Project Context");
  expect(prompt).toContain("read it and follow its instructions first");
  expect(prompt).not.toContain(
    "If runtime-provided startup context is included for this first turn",
  );
});

it("uses bootstrap-specific wording when bootstrap is still pending", async () => {
  const workspaceDir = await makeBootstrapPendingWorkspace();
  const { prompt, ...state } = await resolveBareSessionResetPromptState({ workspaceDir });
  expect(state).toEqual({ bootstrapMode: "full", shouldPrependStartupContext: false });

  expect(prompt).toContain("while bootstrap is still pending for this workspace");
  expect(prompt).toContain("Please read BOOTSTRAP.md from the workspace now");
  expect(prompt).toContain("Can finish BOOTSTRAP.md here: do it.");
  expect(prompt).toContain("brief blocker");
  expect(prompt).toContain("simplest next step");
  expect(prompt).toContain("Never claim completion early");
  expect(prompt).toContain("Your first user-visible reply must follow BOOTSTRAP.md");
  expect(prompt).not.toContain("Then greet the user in your configured persona");
  await fs.unlink(path.join(workspaceDir, "BOOTSTRAP.md"));
  const complete = await resolveBareSessionResetPromptState({ workspaceDir });
  expect(complete).toMatchObject({ bootstrapMode: "none", shouldPrependStartupContext: true });
  expect(complete.prompt).toContain("Execute your Session Startup sequence now");
});

it.each([false, async () => false])(
  "uses limited bootstrap wording with access %s",
  async (hasBootstrapFileAccess) => {
    const workspaceDir = await makeBootstrapPendingWorkspace();
    const pending = await resolveBareSessionResetPromptState({
      workspaceDir,
      hasBootstrapFileAccess,
    });
    const { prompt } = pending;

    expect(pending).toMatchObject({
      bootstrapMode: "limited",
      shouldPrependStartupContext: false,
    });
    expect(prompt).toContain("cannot safely complete the full BOOTSTRAP.md workflow here");
    expect(prompt).toContain("while bootstrap is still pending for this workspace");
    expect(prompt).toContain("Never claim complete");
    expect(prompt).toContain("no generic first greeting");
    expect(prompt).toContain("switching to a primary interactive run with normal workspace access");
    expect(prompt).not.toContain("Please read BOOTSTRAP.md from the workspace now");
    expect(prompt).not.toContain("Execute your Session Startup sequence now");
  },
);

it("does not resolve bootstrap file access when bootstrap is complete", async () => {
  const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-complete-");
  let resolvedAccess = false;

  const complete = await resolveBareSessionResetPromptState({
    workspaceDir,
    hasBootstrapFileAccess: () => {
      resolvedAccess = true;
      return false;
    },
  });

  expect(complete).toMatchObject({ bootstrapMode: "none", shouldPrependStartupContext: true });
  expect(resolvedAccess).toBe(false);
});

it("suppresses bootstrap mode for non-primary bare reset sessions", async () => {
  const workspaceDir = await makeBootstrapPendingWorkspace();

  const pending = await resolveBareSessionResetPromptState({
    workspaceDir,
    isPrimaryRun: false,
  });

  expect(pending).toMatchObject({ bootstrapMode: "none", shouldPrependStartupContext: true });
  expect(pending.prompt).toContain("Execute your Session Startup sequence now");
  expect(pending.prompt).not.toContain("while bootstrap is still pending for this workspace");
});
