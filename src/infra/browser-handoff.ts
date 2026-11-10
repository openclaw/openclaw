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
import { escapeHtml } from "../shared/html-escape.js";
import { openClawMascotStyles, renderOpenClawMascot } from "../shared/openclaw-mascot.js";
import { openClawWordmarkTextSvg } from "../shared/openclaw-wordmark.js";
import { openLocalFile } from "./browser-open.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import {
  createPrivateWindowsDirectory,
  createPrivateWindowsFile,
} from "./windows-private-directory.js";

const HANDOFF_DIR_PREFIX = "openclaw-browser-handoff-";
const HANDOFF_FILE_NAME = "handoff.html";

// The Gateway availability page's light tokens and status anatomy, without its app shell.
// Local handoff files cannot depend on Gateway assets or the application's theme setting.
const HANDOFF_STYLES = `:root{color-scheme:light;--bg:#f8f8f8;--text:#353535;--text-strong:#202020;--muted:#5e5e5e;--accent:#bd4531;--mascot-ground:radial-gradient(closest-side,rgb(32 32 32/.16),rgb(32 32 32/.06) 60%,transparent);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.01em;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}body{margin:0;background:var(--bg)}
.shell{display:flex;min-height:100svh}
.content{position:relative;display:flex;flex-direction:column;flex:1;min-width:0}
.topbar{display:flex;align-items:flex-start;justify-content:center;padding:14.5px 12px 0}
.wordmark{display:block;width:105px;height:32px;color:var(--text-strong)}
main{position:relative;flex:1;min-height:calc(100svh - 64px)}
.body{position:absolute;top:38%;left:50%;width:min(460px,calc(100% - 48px));transform:translateX(-50%);text-align:center}
h1{position:relative;margin:0;color:var(--text-strong);font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.01em;text-wrap:balance}
p{margin:6px 0 0;color:var(--muted);font-size:14px;line-height:21px;text-wrap:pretty}
a{color:var(--muted);text-underline-offset:3px}a:hover{color:var(--text-strong)}a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape){.content{padding:0 4px}.body{top:36%;left:24px;right:24px;width:auto;transform:none}h1{font-size:20px;line-height:26px}}
${openClawMascotStyles({
  busy: ".mascot",
  error: ".mascot[data-pose=error]",
  phone:
    "@media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape)",
})}`;

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
    const href = escapeHtml(normalizedTargetUrl);
    await writeHandoffDocument(
      filePath,
      [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
        '<meta name="color-scheme" content="light">',
        `<meta http-equiv="refresh" content="0; url=${href}">`,
        "<title>OpenClaw</title>",
        `<style>${HANDOFF_STYLES}</style>`,
        "</head>",
        "<body>",
        `<div class="shell"><div class="content"><header class="topbar">${openClawWordmarkTextSvg}</header>`,
        '<main><div class="body">',
        `<h1>${renderOpenClawMascot("openclaw-handoff-mascot-shell")}Opening OpenClaw</h1>`,
        `<p>If nothing happens, <a href="${href}">continue to OpenClaw</a>.</p>`,
        "</div></main></div></div>",
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
