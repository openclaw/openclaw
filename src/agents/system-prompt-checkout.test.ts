import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it.each<Partial<Parameters<typeof buildAgentSystemPrompt>[0]>>([
  {},
  { codeModeActive: true, toolNames: ["exec"], runtimeCwd: "/tmp/repo" },
  { promptMode: "minimal", promptSurface: "subagent" },
  { promptSurface: "cli_backend" },
])("makes shared checkout guidance visible without tool or skill discovery %#", (params) => {
  const prefix = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params }).split(
    SYSTEM_PROMPT_CACHE_BOUNDARY,
  )[0];
  expect(prefix).toContain("including multi-PR batches");
  expect(prefix).toContain("git worktree add");
  expect(prefix).toContain("share its object store");
  expect(prefix).toContain("Do not clone the same repo into task scratch");
});
