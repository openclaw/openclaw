import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ensureNodeScript = resolve(".github/actions/setup-pnpm-store-cache/ensure-node.sh");

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function writeFakeNode(binDir: string, version: string) {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  return writeExecutable(
    nodePath,
    `#!/usr/bin/env bash
if [[ "$1" == "-p" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "$1" == "-v" ]]; then
  echo "v${version}"
  exit 0
fi
exit 0
`,
  );
}

function runEnsureNode(root: string, requested: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const githubPath = join(root, "github-path");
  const pathOverride = extraEnv.PATH;
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -e",
        ...(pathOverride ? [`export PATH=${JSON.stringify(pathOverride)}`] : []),
        `source "${ensureNodeScript}"`,
        `openclaw_ensure_node "${requested}"`,
        "command -v node",
        "node -p 'process.versions.node'",
      ].join("; "),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_PATH: githubPath,
        ...extraEnv,
      },
    },
  );
  return result;
}

function runVersionMatch(actual: string, requested: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        `source "${ensureNodeScript}"`,
        `openclaw_node_version_matches "${actual}" "${requested}"`,
      ].join("; "),
    ],
    { encoding: "utf8", env: process.env },
  );
}

describe("setup-pnpm-store-cache ensure-node", () => {
  it("uses a matching active node", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      const activeNode = writeFakeNode(activeBin, "24.15.0");
      const result = runEnsureNode(root, "24.15.0", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "missing-toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using active Node 24.15.0 at ${activeNode}`);
      expect(result.stdout.trim().endsWith("24.15.0")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs PATH from the toolcache when setup-node leaves an old node active", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const toolcacheBin = join(root, "toolcache", "node", "24.15.0", "x64", "bin");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.15.0");
      const result = runEnsureNode(root, "24.15.0", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 24.15.0 from ${toolcacheNode}`);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.15.0`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows toolcache paths for Git Bash before prepending PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "22.22.3");
      const toolcacheBin = join(root, "toolcache", "node", "24.15.0", "x64");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.15.0");
      const helperBin = join(root, "helpers");
      mkdirSync(helperBin, { recursive: true });
      writeExecutable(
        join(helperBin, "cygpath"),
        `#!/usr/bin/env bash
if [[ "$1" == "-u" ]]; then
  echo "${toolcacheBin}"
  exit 0
fi
if [[ "$1" == "-w" ]]; then
  echo "C:\\\\hostedtoolcache\\\\windows\\\\node\\\\24.15.0\\\\x64"
  exit 0
fi
exit 1
`,
      );
      const githubPath = join(root, "github-path");
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -e",
            `export PATH=${JSON.stringify(`${helperBin}:${activeBin}:${process.env.PATH ?? ""}`)}`,
            `export GITHUB_PATH=${JSON.stringify(githubPath)}`,
            `source "${ensureNodeScript}"`,
            `openclaw_prepend_node_bin "C:\\\\hostedtoolcache\\\\windows/node/24.15.0/x64"`,
            "command -v node",
            "node -p 'process.versions.node'",
            `cat "${githubPath}"`,
          ].join("; "),
        ],
        { encoding: "utf8", env: process.env },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.15.0`);
      expect(result.stdout).toContain("C:\\hostedtoolcache\\windows\\node\\24.15.0\\x64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows toolcache roots before scanning for Node", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "22.22.3");
      const toolcacheRoot = join(root, "toolcache");
      const toolcacheBin = join(toolcacheRoot, "node", "24.15.0", "x64");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.15.0");
      const helperBin = join(root, "helpers");
      mkdirSync(helperBin, { recursive: true });
      writeExecutable(
        join(helperBin, "cygpath"),
        `#!/usr/bin/env bash
if [[ "$1" == "-u" ]]; then
  case "$2" in
    "C:\\\\hostedtoolcache\\\\windows") echo "${toolcacheRoot}" ;;
    *) echo "$2" ;;
  esac
  exit 0
fi
if [[ "$1" == "-w" ]]; then
  echo "$2"
  exit 0
fi
exit 1
`,
      );
      const result = runEnsureNode(root, "24.x", {
        PATH: `${helperBin}:${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: "C:\\hostedtoolcache\\windows",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 24.15.0 from ${toolcacheNode}`);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.15.0`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports Windows Node archive downloads", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const helperBin = join(root, "helpers");
      mkdirSync(helperBin, { recursive: true });
      writeExecutable(
        join(helperBin, "uname"),
        `#!/usr/bin/env bash
case "$1" in
  -s) echo "MINGW64_NT-10.0" ;;
  -m) echo "x86_64" ;;
  *) exit 1 ;;
esac
`,
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -e",
            `export PATH=${JSON.stringify(`${helperBin}:${process.env.PATH ?? ""}`)}`,
            `source "${ensureNodeScript}"`,
            "openclaw_node_download_platform",
          ].join("; "),
        ],
        { encoding: "utf8", env: process.env },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("win-x64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("downloads and activates a Windows Node zip when no matching toolcache node exists", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "22.22.3");
      const helperBin = join(root, "helpers");
      const runnerTemp = join(root, "runner-temp");
      const extractedBin = join(
        runnerTemp,
        "openclaw-node-v24.15.0-win-x64",
        "node-v24.15.0-win-x64",
      );
      mkdirSync(helperBin, { recursive: true });
      mkdirSync(runnerTemp, { recursive: true });
      writeExecutable(
        join(helperBin, "uname"),
        `#!/usr/bin/env bash
case "$1" in
  -s) echo "MINGW64_NT-10.0" ;;
  -m) echo "x86_64" ;;
  *) exit 1 ;;
esac
`,
      );
      writeExecutable(
        join(helperBin, "curl"),
        `#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then out="$arg"; fi
  prev="$arg"
done
[[ -n "$out" ]] && printf 'zip' > "$out"
`,
      );
      writeExecutable(
        join(helperBin, "cygpath"),
        `#!/usr/bin/env bash
if [[ "$1" == "-u" ]]; then
  case "$2" in
    "C:\\\\runner\\\\_temp") echo "${runnerTemp}" ;;
    *) echo "$2" ;;
  esac
  exit 0
fi
if [[ "$1" == "-w" ]]; then
  echo "$2"
  exit 0
fi
exit 1
`,
      );
      writeExecutable(
        join(helperBin, "pwsh"),
        `#!/usr/bin/env bash
mkdir -p "${extractedBin}"
cat > "${join(extractedBin, "node")}" <<'NODEEOF'
#!/usr/bin/env bash
if [[ "$1" == "-p" ]]; then echo "24.15.0"; exit 0; fi
exit 0
NODEEOF
chmod +x "${join(extractedBin, "node")}"
`,
      );
      const result = runEnsureNode(root, "24.15.0", {
        GITHUB_PATH: join(root, "github-path"),
        PATH: `${helperBin}:${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: "C:\\runner\\_temp",
        RUNNER_TOOL_CACHE: join(root, "missing-toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Downloading Node v24.15.0 from https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip",
      );
      expect(result.stdout).toContain(`${join(extractedBin, "node")}\n24.15.0`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs PATH from the container-mounted GitHub Actions toolcache", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const toolcacheBin = join(root, "__t", "node", "24.99.99", "x64", "bin");
      const toolcacheNode = writeFakeNode(toolcacheBin, "24.99.99");
      const result = runEnsureNode(root, "24.99.99", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "__t"),
        RUNNER_TOOL_CACHE: join(root, "hostedtoolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 24.99.99 from ${toolcacheNode}`);
      expect(result.stdout).toContain(`${toolcacheNode}\n24.99.99`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts major wildcard requests when selecting a toolcache node", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const toolcacheBin = join(root, "toolcache", "node", "24.15.0", "x64", "bin");
      writeFakeNode(toolcacheBin, "24.15.0");
      const result = runEnsureNode(root, "24.x", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().endsWith("24.15.0")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the Node 22 wildcard at the supported minimum", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "22.18.0");
      const toolcacheBin = join(root, "toolcache", "node", "22.22.3", "x64", "bin");
      const toolcacheNode = writeFakeNode(toolcacheBin, "22.22.3");
      const result = runEnsureNode(root, "22.x", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Using Node 22.22.3 from ${toolcacheNode}`);
      expect(result.stdout.trim().endsWith("22.22.3")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Node 22 wildcard matches below the supported minimum", () => {
    expect(runVersionMatch("22.18.0", "22.x").status).toBe(1);
    expect(runVersionMatch("22.19.0", "22.x").status).toBe(0);
  });

  it("fails clearly when no matching node is available", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-ensure-node-"));
    try {
      const activeBin = join(root, "active", "bin");
      writeFakeNode(activeBin, "20.20.0");
      const result = runEnsureNode(root, "99.99.99", {
        PATH: `${activeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TOOL_CACHE: join(root, "toolcache"),
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("::error::Expected Node '99.99.99'");
      expect(result.stdout).toContain("active node is '20.20.0'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
