import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readClaudeCliFallbackSeed } from "./cli-session-history.claude.js";
import {
  readClaudeCliSessionMessagesAsync,
  createClaudeTextHistoryLines,
  claudeUser,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";

function history(uuid: string, content: string, role: "user" | "assistant" = "user") {
  return createClaudeTextHistoryLines([{ role, uuid, content }]);
}

const writeHistory = (file: string, ...entry: Parameters<typeof history>) =>
  fs.writeFile(file, history(...entry));

const messageShape = (externalId: string, content: unknown) => ({
  __openclaw: { externalId },
  content,
});

it("imports and seeds history only from the selected Claude config root", () =>
  withClaudeProjectsDir(async ({ homeDir, sessionId, filePath, readMessages }) => {
    const selected = { role: "assistant", content: "Selected account answer" };
    const configDir = path.join(homeDir, "selected-claude");
    const projectDir = path.join(configDir, "projects", "configured-workspace");
    const selectedFile = path.join(projectDir, path.basename(filePath));
    await fs.mkdir(projectDir, { recursive: true });
    await writeHistory(selectedFile, "selected-account", "Selected account answer", "assistant");
    await withEnvAsync({ CLAUDE_CONFIG_DIR: configDir }, async () => {
      expect(await readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId })).toMatchObject([
        selected,
      ]);
      expect(await readClaudeCliFallbackSeed({ cliSessionId: sessionId })).toMatchObject({
        recentTurns: [selected],
      });
      // Explicit offline homes remain isolated from the running Gateway's account.
      expect(await readMessages()).toHaveLength(3);
      await fs.rm(selectedFile);
      expect(await readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId })).toEqual([]);
      expect(await readClaudeCliFallbackSeed({ cliSessionId: sessionId })).toBeUndefined();
    });
  }));

it("reads changed Claude sources and preserves discovery precedence", () =>
  withClaudeProjectsDir(async ({ filePath, readMessages: read }) => {
    expect(await read()).toHaveLength(3);

    await fs.appendFile(filePath, `\n${history("appended-user", "appended")}`, "utf8");
    const appended = await read();
    expect(appended).toHaveLength(4);
    expect(appended.map((message) => message["__openclaw"])).toContainEqual(
      expect.objectContaining({ externalId: "appended-user" }),
    );

    await writeHistory(filePath, "replacement-assistant", "replacement", "assistant");
    const replaced = await read();
    expect(replaced).toMatchObject([messageShape("replacement-assistant", "replacement")]);

    const movedProjectDir = path.join(path.dirname(path.dirname(filePath)), "moved-workspace");
    await fs.mkdir(movedProjectDir);
    const movedFilePath = path.join(movedProjectDir, path.basename(filePath));
    await fs.rename(filePath, movedFilePath);
    expect(await read()).toEqual(replaced);

    await fs.rm(movedFilePath);
    expect(await read()).toEqual([]);
  }));

it("preserves project precedence when a later matching transcript is found first", () =>
  withClaudeProjectsDir(async ({ filePath, readMessages }) => {
    const projectsDir = path.dirname(path.dirname(filePath));
    const otherProjectDir = path.join(projectsDir, "other-workspace");
    await fs.mkdir(otherProjectDir);
    await writeHistory(path.join(otherProjectDir, path.basename(filePath)), "other", "other");
    const [firstPath, secondPath] = (await fs.readdir(projectsDir)).map((project) =>
      path.join(projectsDir, project, path.basename(filePath)),
    );
    await writeHistory(filePath, "original", "original");
    const releaseFirst = createDeferred();
    const foundSecond = createDeferred();
    const access = fs.access;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (candidate, mode) => {
      if (candidate === firstPath) {
        await releaseFirst.promise;
      }
      await access(candidate, mode);
      if (candidate === secondPath) {
        foundSecond.resolve();
      }
    });
    const pending = readMessages();
    try {
      await Promise.race([foundSecond.promise, pending]);
      releaseFirst.resolve();
      expect(await pending).toMatchObject([
        { content: firstPath === filePath ? "original" : "other" },
      ]);
    } finally {
      releaseFirst.resolve();
      await pending;
      accessSpy.mockRestore();
    }
  }));

it("bounds oversized Claude messages and continues after malformed records", () =>
  withClaudeProjectsDir(async ({ filePath, readMessages }) => {
    const record = (uuid: string, content: unknown) =>
      JSON.stringify(claudeUser(content, { uuid }));
    const oversized = "q".repeat(2 * 1024 * 1024);
    await fs.writeFile(
      filePath,
      [
        record("oversized-user-0", oversized),
        "!".repeat(2 * 1024 * 1024),
        record("oversized-tool-result", [
          { type: "tool_result", tool_use_id: "tool-1", content: oversized },
        ]),
        record("visible-after-oversized", "visible"),
      ].join("\n"),
      "utf8",
    );
    const omitted = expect.stringContaining("exceeded 1 MiB");
    // A tool result must keep its shape, or the placeholder renders as a user turn.
    expect(await readMessages()).toMatchObject([
      messageShape("oversized-user-0", omitted),
      messageShape("oversized-tool-result", [
        { type: "tool_result", tool_use_id: "tool-1", content: omitted },
      ]),
      messageShape("visible-after-oversized", "visible"),
    ]);
  }));
