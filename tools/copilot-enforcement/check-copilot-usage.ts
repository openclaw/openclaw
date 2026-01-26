import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type FindingKind = "import" | "dependency";

type Finding = {
  file: string;
  kind: FindingKind;
  specifier: string;
  line: number | null;
};

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "vendor",
  "coverage",
  ".turbo",
  ".next",
  "build",
]);

const COPILOT_IMPORT_PATTERN = /(?:from\s+|require\(|import\()\s*["'](@github\/copilot[^"']*)["']/g;
const COPILOT_SIDE_EFFECT_PATTERN = /import\s*["'](@github\/copilot[^"']*)["']/g;

export async function scanCopilotUsage(rootDir: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  await walkDirectory(rootDir, async (filePath) => {
    const relativePath = path.relative(rootDir, filePath);

    if (path.basename(filePath) === "package.json") {
      const packageFindings = await scanPackageJson(filePath, relativePath);
      findings.push(...packageFindings);
      return;
    }

    if (!CODE_EXTENSIONS.has(path.extname(filePath))) {
      return;
    }

    const content = await readFile(filePath, "utf8");
    findings.push(...scanSourceFile(content, relativePath));
  });

  return findings;
}

async function walkDirectory(
  dirPath: string,
  onFile: (filePath: string) => Promise<void>
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      await walkDirectory(path.join(dirPath, entry.name), onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(path.join(dirPath, entry.name));
    }
  }
}

function scanSourceFile(content: string, relativePath: string): Finding[] {
  const findings: Finding[] = [];

  for (const pattern of [COPILOT_IMPORT_PATTERN, COPILOT_SIDE_EFFECT_PATTERN]) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === "@github/copilot-sdk") {
        continue;
      }
      if (specifier.startsWith("@github/copilot")) {
        findings.push({
          file: relativePath,
          kind: "import",
          specifier,
          line: getLineNumber(content, match.index ?? 0),
        });
      }
    }
  }

  return findings;
}

async function scanPackageJson(
  filePath: string,
  relativePath: string
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const content = await readFile(filePath, "utf8");

  try {
    const json = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    const dependencyBlocks = [
      json.dependencies,
      json.devDependencies,
      json.peerDependencies,
      json.optionalDependencies,
    ];

    for (const block of dependencyBlocks) {
      if (!block) {
        continue;
      }

      for (const name of Object.keys(block)) {
        if (name === "@github/copilot-sdk") {
          continue;
        }
        if (name.startsWith("@github/copilot")) {
          findings.push({
            file: relativePath,
            kind: "dependency",
            specifier: name,
            line: null,
          });
        }
      }
    }
  } catch {
    return findings;
  }

  return findings;
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map((finding) => {
      const line = finding.line ? `:${finding.line}` : "";
      return `${finding.file}${line} - ${finding.kind} ${finding.specifier}`;
    })
    .join("\n");
}

async function runCli(): Promise<void> {
  const rootDir = process.cwd();
  const findings = await scanCopilotUsage(rootDir);

  if (findings.length === 0) {
    console.log("Copilot SDK check passed.");
    return;
  }

  console.error("Non-SDK Copilot usage detected:\n" + formatFindings(findings));
  process.exitCode = 1;
}

const isCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  runCli();
}
