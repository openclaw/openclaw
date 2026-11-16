import { expect, it } from "vitest";
import { buildAgentHarnessBasePrompt } from "./system-prompt-harness-base.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it.each([
  ["ordinary", () => buildAgentSystemPrompt({ workspaceDir: "/tmp/repo" })],
  [
    "Code Mode",
    () =>
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/repo",
        codeModeActive: true,
        toolNames: ["exec"],
      }),
  ],
  [
    "subagent",
    () =>
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/repo",
        promptMode: "minimal",
        promptSurface: "subagent",
      }),
  ],
  [
    "CLI",
    () => buildAgentSystemPrompt({ workspaceDir: "/tmp/repo", promptSurface: "cli_backend" }),
  ],
  ["native harness", () => buildAgentHarnessBasePrompt({ toolNames: ["exec"] })],
  [
    "minimal native harness",
    () => buildAgentHarnessBasePrompt({ toolNames: ["exec"], promptMode: "minimal" }),
  ],
] as const)("makes shared checkout guidance visible without discovery: %s", (_name, render) => {
  const prompt = render();
  expect(prompt).toContain("including multi-PR batches");
  expect(prompt).toContain("git worktree add");
  expect(prompt).toContain("share its object store");
  expect(prompt).toContain("Do not clone the same repo into task scratch");
});
