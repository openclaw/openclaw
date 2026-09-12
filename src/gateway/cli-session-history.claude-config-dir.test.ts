// Native transcript locations are independent fixtures, including wrong-root decoys.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClaudeCliSessionMessagesAsync } from "./cli-session-history.claude-snapshot.js";
import {
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
} from "./cli-session-history.claude.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionId = "native-history-session";

async function writeTranscript(root: string, text: string) {
  // Native resume can find a session after its project folder has moved.
  const projectDir = path.join(root, "projects", "moved-project");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      uuid: "native-assistant",
      timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

async function fixture() {
  const root = await fs.realpath(tempDirs.make("openclaw-claude-history-root-"));
  const homeDir = path.join(root, "home");
  const cwd = path.join(root, "child cwd");
  await fs.mkdir(cwd, { recursive: true });
  vi.stubEnv("HOME", path.join(root, "different-home"));
  return { root, homeDir, cwd, cliSessionId: sessionId };
}

describe("Claude configured transcript roots", () => {
  it.each(["unset", "absolute", "relative", "empty", "unicode"] as const)(
    "reads the selected %s root consistently for sync, async, and fallback history",
    async (kind) => {
      const params = await fixture();
      const defaultRoot = path.join(params.homeDir, ".claude");
      const selectedRoot =
        kind === "unset"
          ? defaultRoot
          : kind === "empty"
            ? params.cwd
            : kind === "relative"
              ? path.join(params.cwd, "relative profile")
              : kind === "unicode"
                ? path.join(params.root, "café")
                : path.join(params.root, "selected profile");
      const configDir =
        kind === "unset"
          ? undefined
          : kind === "empty"
            ? ""
            : kind === "relative"
              ? "relative profile"
              : kind === "unicode"
                ? path.join(params.root, "cafe\u0301")
                : selectedRoot;
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      if (selectedRoot !== defaultRoot) {
        await writeTranscript(defaultRoot, "Wrong default history");
      }
      await writeTranscript(selectedRoot, "Selected native history");
      for (const result of [
        readClaudeCliSessionMessages(params),
        await readClaudeCliSessionMessagesAsync(params),
        readClaudeCliFallbackSeed(params),
      ]) {
        expect(JSON.stringify(result)).toContain("Selected native history");
        expect(JSON.stringify(result)).not.toContain("Wrong default history");
      }
    },
  );

  it("does not guess a relative root when the child cwd is unknown", async () => {
    const { homeDir } = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", "relative profile");
    await writeTranscript(path.join(homeDir, ".claude"), "Wrong default history");
    const params = { cliSessionId: sessionId, homeDir };
    expect(readClaudeCliSessionMessages(params)).toEqual([]);
    expect(await readClaudeCliSessionMessagesAsync(params)).toEqual([]);
    expect(readClaudeCliFallbackSeed(params)).toBeUndefined();
  });

  it("resolves a symlinked child cwd before the relative parent path", async () => {
    const params = await fixture();
    const physicalCwd = path.join(params.root, "physical", "child");
    const logicalCwd = path.join(params.root, "logical");
    await fs.mkdir(physicalCwd, { recursive: true });
    await fs.symlink(physicalCwd, logicalCwd, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "../profile");
    await writeTranscript(path.join(params.root, "profile"), "Wrong lexical parent");
    await writeTranscript(path.join(params.root, "physical", "profile"), "Physical native history");
    const lookup = { ...params, cwd: logicalCwd };
    for (const messages of [
      readClaudeCliSessionMessages(lookup),
      await readClaudeCliSessionMessagesAsync(lookup),
    ]) {
      expect(JSON.stringify(messages)).toContain("Physical native history");
      expect(JSON.stringify(messages)).not.toContain("Wrong lexical parent");
    }
  });

  it("invalidates the imported snapshot when the selected profile changes", async () => {
    const params = await fixture();
    const firstRoot = path.join(params.root, "first-profile");
    const secondRoot = path.join(params.root, "second-profile");
    await writeTranscript(firstRoot, "History from profile A");
    await writeTranscript(secondRoot, "History from profile B");
    vi.stubEnv("CLAUDE_CONFIG_DIR", firstRoot);
    expect(JSON.stringify(await readClaudeCliSessionMessagesAsync(params))).toContain("profile A");
    vi.stubEnv("CLAUDE_CONFIG_DIR", secondRoot);
    const messages = await readClaudeCliSessionMessagesAsync(params);
    expect(JSON.stringify(messages)).toContain("profile B");
    expect(JSON.stringify(messages)).not.toContain("profile A");
  });
});
