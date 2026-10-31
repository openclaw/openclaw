import { expect, it } from "vitest";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";

it("replaces the failed /compact advice with a warned, session-specific trim command", () => {
  const text = buildContextOverflowRecoveryText({ agentId: "main", sessionKey: "agent:main:main" });
  expect(text).toContain("kept this conversation mapped to the current session");
  expect(text).toContain("Use /new to start a fresh session.");
  expect(text).toContain("Try a model with a larger context window.");
  expect(text).not.toContain("/compact");
  expect(text).not.toContain("reset our conversation");
  const warningAt = text.indexOf("permanently deletes older history and keeps no backup");
  const backupAt = text.indexOf("`openclaw backup create`");
  const commandAt = text.indexOf(
    "`openclaw sessions compact agent:main:main --agent main --max-lines 200`.",
  );
  expect(warningAt).toBeGreaterThan(-1);
  expect(backupAt).toBeGreaterThan(warningAt);
  expect(commandAt).toBeGreaterThan(backupAt);
});

it("labels the POSIX and PowerShell form together when their quoting matches", () => {
  const key = "agent:main:matrix:channel:!ops:example.org:thread:$RootEvent:Example.Org";
  const text = buildContextOverflowRecoveryText({ agentId: "main", sessionKey: key });
  expect(text).toContain(
    `then \`openclaw sessions compact '${key}' --agent main --max-lines 200\` (macOS, Linux, or PowerShell)` +
      ` or \`openclaw sessions compact "${key}" --agent main --max-lines 200\` (Windows Command Prompt).`,
  );
});

it("renders a separate PowerShell form when an apostrophe makes the quoting diverge", () => {
  const text = buildContextOverflowRecoveryText({
    agentId: "main",
    sessionKey: "agent:main:bob's",
  });
  expect(text).toContain(
    "then `openclaw sessions compact 'agent:main:bob'\\''s' --agent main --max-lines 200` (macOS or Linux)," +
      " `openclaw sessions compact 'agent:main:bob''s' --agent main --max-lines 200` (PowerShell)," +
      ' or `openclaw sessions compact "agent:main:bob\'s" --agent main --max-lines 200` (Windows Command Prompt).',
  );
});

it("shows a key placeholder when the session key is unknown", () => {
  const text = buildContextOverflowRecoveryText();
  expect(text).toContain("`openclaw sessions compact <session-key> --max-lines 200`.");
  expect(text).not.toContain("/compact");
});
