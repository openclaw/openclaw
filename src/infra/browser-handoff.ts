// Private browser handoff for credential-bearing URLs.
//
// Launching an authenticated URL through a desktop opener (xdg-open, wslview,
// open) places the complete URL, including any credential fragment, in the
// child process's command line. On hosts where separate OS users share a
// default procfs, other local accounts can read that credential from
// /proc/<pid>/cmdline and redeem it before the intended browser does.
//
// This module keeps the credential out of process arguments: the target URL is
// written to a one-time document inside a private temporary directory, and
// only that non-secret file path is handed to the browser opener. The document
// redirects the intended browser to the real target.
//
// Privacy is established per platform: POSIX uses a 0700 mkdtemp directory
// and a 0600 file; Windows uses fs-safe private creation, which applies an
// owner-only protected ACL to both the directory and the file rather than
// relying on inherited temp-directory permissions.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openLocalFile } from "./browser-open.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import {
  createPrivateWindowsDirectory,
  createPrivateWindowsFile,
} from "./windows-private-directory.js";

const HANDOFF_DIR_PREFIX = "openclaw-browser-handoff-";
const HANDOFF_FILE_NAME = "handoff.html";

// Clean up the handoff document once the short-lived credentials it carries
// have expired. The timer is unref'd so CLI commands still exit promptly, and
// the 0700/0600 document stays unreadable to other OS users even if cleanup
// is skipped because the process already exited.
const HANDOFF_CLEANUP_DELAY_MS = 10 * 60 * 1000;

/** Create the private handoff directory with platform-appropriate owner-only access. */
async function createHandoffDirectory(): Promise<string> {
  if (process.platform !== "win32") {
    // mkdtemp creates the directory with mode 0700 under the shared secure
    // OpenClaw temp root (owner-scoped fallback), never a bare os.tmpdir path.
    return await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), HANDOFF_DIR_PREFIX));
  }
  const directory = path.join(
    resolvePreferredOpenClawTmpDir(),
    `${HANDOFF_DIR_PREFIX}${randomUUID()}`,
  );
  createPrivateWindowsDirectory(directory);
  return directory;
}

/** Write the handoff document with platform-appropriate owner-only access. */
async function writeHandoffDocument(filePath: string, content: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.writeFile(filePath, content, { mode: 0o600, flag: "wx" });
    return;
  }
  const file = createPrivateWindowsFile(filePath);
  try {
    fsSync.writeFileSync(file.fd, content);
  } finally {
    file.close();
  }
}

async function removeHandoffDirectory(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

/**
 * Open a credential-bearing URL in the user's browser without exposing it in
 * any process's command line. The URL is delivered through a private one-time
 * handoff document; only that document's file path reaches the browser opener.
 * Returns true when the handoff document was handed off successfully.
 */
export async function openUrlPrivately(targetUrl: string): Promise<boolean> {
  const parsed = URL.parse(targetUrl);
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") {
    return false;
  }
  // Render the document from the normalized URL so the fragment is
  // percent-encoded exactly as the final browser navigation will use it.
  const normalizedTargetUrl = parsed.toString();

  let directory: string;
  try {
    // Only this OS user can traverse the directory, so the credential cannot
    // leak across the OS-user boundary even while the document exists.
    directory = await createHandoffDirectory();
  } catch {
    return false;
  }

  const filePath = path.join(directory, HANDOFF_FILE_NAME);
  try {
    const href = normalizedTargetUrl
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
    await writeHandoffDocument(
      filePath,
      [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        `<meta http-equiv="refresh" content="0; url=${href}">`,
        "<title>OpenClaw</title>",
        "</head>",
        "<body>",
        "<p>Opening the OpenClaw Control UI…</p>",
        `<p>If nothing happens, <a href="${href}">continue to OpenClaw</a>.</p>`,
        `<script>location.replace(${JSON.stringify(normalizedTargetUrl).replaceAll("<", "\\u003c")});</script>`,
        "</body>",
        "</html>",
        "",
      ].join("\n"),
    );
  } catch {
    await removeHandoffDirectory(directory);
    return false;
  }

  const opened = await openLocalFile(filePath).catch(() => false);
  if (!opened) {
    await removeHandoffDirectory(directory);
    return false;
  }

  const cleanup = setTimeout(() => {
    void removeHandoffDirectory(directory);
  }, HANDOFF_CLEANUP_DELAY_MS);
  cleanup.unref?.();
  return true;
}
