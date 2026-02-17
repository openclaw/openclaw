import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logVerbose } from "../../globals.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import type { CommandHandler } from "./commands-types.js";

function resolveGhBinary(): string | null {
  try {
    const result = execSync("which gh", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function isGhAuthenticated(ghBin: string): boolean {
  try {
    execSync(`"${ghBin}" auth status`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export const handleShareSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/share" && !normalized.startsWith("/share ")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /share from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Check for gh CLI availability
  const ghBin = resolveGhBinary();
  if (!ghBin) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "❌ GitHub CLI (`gh`) not found.",
          "",
          "Install it from https://cli.github.com/ and run `gh auth login` to continue.",
        ].join("\n"),
      },
    };
  }

  // Check for gh authentication
  if (!isGhAuthenticated(ghBin)) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "❌ GitHub CLI is not authenticated.",
          "",
          "Run `gh auth login` to authenticate, then try `/share` again.",
        ].join("\n"),
      },
    };
  }

  // Check for active session
  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No active session found." },
    };
  }

  // Generate HTML via the export pipeline
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmpFile = path.join(
    os.tmpdir(),
    `openclaw-share-${params.sessionEntry.sessionId.slice(0, 8)}-${timestamp}.html`,
  );

  let exportResult: Awaited<ReturnType<typeof buildExportSessionReply>>;
  try {
    // Temporarily override workspaceDir to write to tmpdir
    exportResult = await buildExportSessionReply({
      ...params,
      workspaceDir: os.tmpdir(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`/share: export failed: ${msg}`);
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to generate session HTML: ${msg}` },
    };
  }

  // If export returned an error, surface it
  if (!exportResult.text || exportResult.text.startsWith("❌")) {
    return { shouldContinue: false, reply: exportResult };
  }

  // Locate the generated file in tmpdir
  const writtenMatch = exportResult.text.match(/📄 File: (.+)/);
  const writtenFile = writtenMatch ? path.resolve(os.tmpdir(), writtenMatch[1]) : null;
  const fileToUpload = writtenFile && fs.existsSync(writtenFile) ? writtenFile : tmpFile;

  if (!fs.existsSync(fileToUpload)) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Could not locate exported HTML file for upload." },
    };
  }

  // Upload to GitHub Gist
  let gistUrl: string;
  try {
    const output = execSync(
      `"${ghBin}" gist create --public --filename "openclaw-session.html" "${fileToUpload}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const url = output.trim().split("\n").at(-1)?.trim() ?? "";
    if (!url.startsWith("http")) {
      throw new Error(`Unexpected gh output: ${output.trim()}`);
    }
    gistUrl = url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`/share: gh gist create failed: ${msg}`);
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to publish Gist: ${msg}` },
    };
  } finally {
    // Clean up temporary file
    try {
      if (fs.existsSync(fileToUpload)) {
        fs.unlinkSync(fileToUpload);
      }
    } catch (cleanupErr) {
      logVerbose(`/share: cleanup failed: ${String(cleanupErr)}`);
    }
  }

  const entryCountMatch = exportResult.text.match(/📊 Entries: (\d+)/);
  const entryCount = entryCountMatch ? entryCountMatch[1] : "?";

  return {
    shouldContinue: false,
    reply: {
      text: ["✅ Session shared!", "", `🔗 ${gistUrl}`, `📊 Entries: ${entryCount}`].join("\n"),
    },
  };
};
