import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { note } from "../terminal/note.js";

export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");
  const srcEntry = path.join(root, "src", "entry.ts");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install");
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}

/**
 * Scan well-known locations for multiple openclaw binaries.
 * If two or more *distinct* installations exist (different realpath),
 * emit a doctor note listing each location + version and remediation steps.
 *
 * Binary-level scan always runs. Systemd service scan is lightweight
 * (only reads directory listings) so it also runs unconditionally.
 */
export function detectDuplicateInstallations(): void {
  // Map<realPath, displayPath> — dedup by resolved path, display the user-facing one
  const seen = new Map<string, string>();

  const candidatePaths = buildCandidatePaths();

  for (const p of candidatePaths) {
    try {
      if (!fs.existsSync(p)) {
        continue;
      }
      const real = fs.realpathSync(p);
      if (!seen.has(real)) {
        seen.set(real, p);
      }
    } catch {
      // realpath failed (broken symlink, permission denied) — skip
    }
  }

  if (seen.size < 2) {
    return;
  }

  // Collect version info for each distinct installation
  const entries = [...seen.entries()].map(([real, display]) => ({
    path: display,
    version: resolveVersion(real, display),
  }));

  // Scan for duplicate systemd services
  const services = scanSystemdServices();

  // Build the note
  const lines: string[] = [
    `Found ${entries.length} openclaw installations:`,
    ...entries.map((e) => (e.version ? `- ${e.path} (v${e.version})` : `- ${e.path}`)),
    "",
    "Multiple installations can cause:",
    "- Gateway port conflicts and infinite restart loops",
    "- Confusing `which openclaw` output",
    "- Version mixing between installations",
  ];

  if (services.length > 1) {
    lines.push(
      "",
      `Also found ${services.length} OpenClaw-related systemd services:`,
      ...services.map((s) => `  - ${s}`),
    );
  }

  lines.push(
    "",
    "Recommendation: Keep one installation and remove the others.",
    "For npm global installs:",
    "  Remove system-level: sudo npm uninstall -g openclaw",
    "  Remove user-level:   npm uninstall -g openclaw",
    "",
    "After removal, verify with: which openclaw && openclaw --version",
  );

  note(lines.join("\n"), "Duplicate installations");
}

function buildCandidatePaths(): string[] {
  const home = process.env.HOME || "";
  const paths: string[] = [
    "/usr/bin/openclaw",
    "/usr/local/bin/openclaw",
    "/bin/openclaw",
    "/opt/bin/openclaw",
  ];

  // npm global root (system-level)
  try {
    const npmRoot = execSync("npm root -g", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (npmRoot) {
      paths.push(path.join(npmRoot, "..", "bin", "openclaw"));
    }
  } catch {
    // npm not available
  }

  // User-level npm global (PREFIX=~/.npm-global convention)
  if (home) {
    paths.push(path.join(home, ".npm-global", "bin", "openclaw"));
    // volta
    paths.push(path.join(home, ".volta", "bin", "openclaw"));
    // fnm
    paths.push(
      path.join(
        home,
        ".local",
        "share",
        "fnm",
        "node-versions",
        "default",
        "installation",
        "bin",
        "openclaw",
      ),
    );
  }

  // nvm current
  if (process.env.NVM_DIR) {
    paths.push(path.join(process.env.NVM_DIR, "current", "bin", "openclaw"));
  }

  return paths;
}

function resolveVersion(realPath: string, displayPath: string): string | undefined {
  // Prefer package.json near the module root
  // Typical layout: <prefix>/lib/node_modules/openclaw/bin/openclaw → package.json is ../../package.json from the binary
  for (const rel of [
    path.join(realPath, "..", "package.json"),
    path.join(realPath, "..", "..", "package.json"),
  ]) {
    try {
      if (fs.existsSync(rel)) {
        const pkg = JSON.parse(fs.readFileSync(rel, "utf8"));
        if (typeof pkg.version === "string") {
          return pkg.version;
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback: run the binary
  try {
    const out = execSync(`"${displayPath}" --version 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5000,
    });
    const first = out.trim().split("\n")[0];
    if (first) {
      return first;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function scanSystemdServices(): string[] {
  const home = process.env.HOME || "";
  const dirs = [
    "/etc/systemd/system",
    home ? path.join(home, ".config", "systemd", "user") : "",
  ].filter(Boolean);

  const found: string[] = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const file of fs.readdirSync(dir)) {
        if (file.includes("openclaw") && file.endsWith(".service")) {
          found.push(`${file} (${dir})`);
        }
      }
    } catch {
      // permission denied
    }
  }
  return found;
}
