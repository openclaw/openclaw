import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { RuntimeEnv } from "../runtime.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { CONFIG_DIR } from "../utils.js";

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type NamedAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

export type SignalInstallResult = {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
};

function looksLikeArchive(name: string): boolean {
  return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}

function pickAsset(assets: ReleaseAsset[], platform: NodeJS.Platform) {
  const withName = assets.filter((asset): asset is NamedAsset =>
    Boolean(asset.name && asset.browser_download_url),
  );
  const byName = (pattern: RegExp) =>
    withName.find((asset) => pattern.test(asset.name.toLowerCase()));

  if (platform === "linux") {
    return (
      byName(/linux-native/) ||
      byName(/linux/) ||
      withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  if (platform === "darwin") {
    return (
      byName(/macos|osx|darwin/) ||
      withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  if (platform === "win32") {
    return (
      byName(/windows|win/) || withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  return withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()));
}

async function downloadToFile(url: string, dest: string, maxRedirects = 5): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        if (!location || maxRedirects <= 0) {
          reject(new Error("Redirect loop or missing Location header"));
          return;
        }
        const redirectUrl = new URL(location, url).href;
        resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve).catch(reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function findSignalCliBinary(root: string): Promise<string | null> {
  const candidates: string[] = [];
  const enqueue = async (dir: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await enqueue(full, depth + 1);
      } else if (entry.isFile() && entry.name === "signal-cli") {
        candidates.push(full);
      }
    }
  };
  await enqueue(root, 0);
  return candidates[0] ?? null;
}

export async function installSignalCli(runtime: RuntimeEnv): Promise<SignalInstallResult> {
  if (process.platform === "win32") {
    return {
      ok: false,
      error: "Signal CLI auto-install is not supported on Windows yet.",
    };
  }

  const apiUrl = "https://api.github.com/repos/AsamK/signal-cli/releases/latest";
  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent": "openclaw",
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `Failed to fetch release info (${response.status})`,
    };
  }

  const payload = (await response.json()) as ReleaseResponse;
  const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
  const assets = payload.assets ?? [];
  const asset = pickAsset(assets, process.platform);
  const assetName = asset?.name ?? "";
  const assetUrl = asset?.browser_download_url ?? "";

  if (!assetName || !assetUrl) {
    return {
      ok: false,
      error: "No compatible release asset found for this platform.",
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-"));
  const archivePath = path.join(tmpDir, assetName);

  runtime.log(`Downloading signal-cli ${version} (${assetName})…`);
  await downloadToFile(assetUrl, archivePath);

  const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
  await fs.mkdir(installRoot, { recursive: true });

  // Validate archive entries to prevent path traversal and symlink attacks (CWE-22)
  try {
    const isZip = assetName.endsWith(".zip");
    // Use verbose listing to detect both path traversal and symlinks
    const listArgv = isZip ? ["unzip", "-Z", archivePath] : ["tar", "tvf", archivePath];
    const listResult = await runCommandWithTimeout(listArgv, { timeoutMs: 60_000 });
    if (listResult.code === 0) {
      const resolvedRoot = path.resolve(installRoot);
      const lines = listResult.stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        // Reject symlinks: they can be used to redirect writes outside target.
        // Symlink entries start with 'l' in verbose listing (both tar and zipinfo).
        if (line.startsWith("l")) {
          if (isZip) {
            return { ok: false, error: "Archive contains symlinks (potential traversal vector)" };
          }
          // For tar, check if symlink target escapes
          const arrowIdx = line.indexOf(" -> ");
          if (arrowIdx !== -1) {
            const target = line.slice(arrowIdx + 4);
            const resolvedLink = path.resolve(installRoot, target);
            if (
              resolvedLink !== resolvedRoot &&
              !resolvedLink.startsWith(resolvedRoot + path.sep)
            ) {
              return { ok: false, error: `Archive symlink escapes target: ${target}` };
            }
          }
        }
        // For tar, also check entry names for path traversal (no built-in protection)
        if (!isZip) {
          const arrowIdx = line.indexOf(" -> ");
          const namePart = arrowIdx !== -1 ? line.slice(0, arrowIdx) : line;
          const entryName = namePart.split(/\s+/).at(-1) ?? "";
          if (entryName) {
            const normalized = entryName.replaceAll("\\", "/");
            const resolved = path.resolve(installRoot, normalized);
            if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
              return { ok: false, error: `Archive entry escapes target directory: ${entryName}` };
            }
          }
        }
      }
    }
  } catch {
    // If listing fails (e.g. tool not available), let extraction proceed
  }

  if (assetName.endsWith(".zip")) {
    // -n: never overwrite existing files (defense-in-depth)
    await runCommandWithTimeout(["unzip", "-q", "-n", archivePath, "-d", installRoot], {
      timeoutMs: 60_000,
    });
  } else if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tgz")) {
    // -k: keep existing files (defense-in-depth)
    await runCommandWithTimeout(["tar", "-xzf", archivePath, "-k", "-C", installRoot], {
      timeoutMs: 60_000,
    });
  } else {
    return { ok: false, error: `Unsupported archive type: ${assetName}` };
  }

  const cliPath = await findSignalCliBinary(installRoot);
  if (!cliPath) {
    return {
      ok: false,
      error: `signal-cli binary not found after extracting ${assetName}`,
    };
  }

  await fs.chmod(cliPath, 0o755).catch(() => {});

  return { ok: true, cliPath, version };
}
