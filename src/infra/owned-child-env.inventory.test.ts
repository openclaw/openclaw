import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_ROOT = "src";
const CHILD_PROCESS_METHODS = new Set(["spawn", "execFile", "exec", "fork"]);
const REVIEWED_EXEMPTION_RE = /owned-child-env:\s*reviewed non-owned\b/;
const REVIEWED_NON_OWNED_EXEMPTIONS = new Map<string, string>([
  [
    "src/acp/client.ts:143:spawn",
    "ACP client launches caller-selected ACP stdio servers with an ACP-specific env strip list.",
  ],
  [
    "src/cli/proxy-cli.runtime.ts:107:spawn",
    "Debug proxy CLI runs the user command with proxy env overlays, not as a broker-owned runtime child.",
  ],
  [
    "src/cli/update-cli/restart-helper.ts:398:spawn",
    "Detached restart script must outlive the updater process and is service-management, not runtime execution.",
  ],
  [
    "src/cli/update-cli/update-command.ts:1615:spawn",
    "Windows taskkill cleanup targets an updater child and carries no runtime secret surface.",
  ],
  [
    "src/cli/update-cli/update-command.ts:1659:spawn",
    "Post-core update handoff respawns the CLI with updater-specific env continuity.",
  ],
  [
    "src/commands/doctor-cron.ts:141:execFile",
    "Doctor command reads the user's crontab for diagnostics.",
  ],
  [
    "src/commands/doctor-gateway-services.ts:227:execFile",
    "Doctor cleanup invokes launchctl service-management commands.",
  ],
  [
    "src/commands/doctor-gateway-services.ts:228:execFile",
    "Doctor cleanup invokes launchctl service-management commands.",
  ],
  [
    "src/commands/doctor-platform-notes.ts:40:execFile",
    "Doctor notes inspect launchctl environment state.",
  ],
  [
    "src/crestodian/probes.ts:20:spawn",
    "Local availability probe for user-visible command diagnostics.",
  ],
  [
    "src/daemon/exec-file.ts:11:execFile",
    "Daemon helper executes caller-supplied service-management commands with caller options.",
  ],
  [
    "src/daemon/launchd-restart-handoff.ts:204:spawn",
    "Launchd restart handoff uses host-service env sanitization, not broker runtime env ownership.",
  ],
  [
    "src/daemon/schtasks.ts:328:spawn",
    "Windows scheduled task fallback preserves the task's configured environment for service restart.",
  ],
  [
    "src/daemon/schtasks.ts:342:spawn",
    "Windows scheduled task script launch is service-management restart plumbing.",
  ],
  [
    "src/entry.ts:115:spawn",
    "CLI self-respawn uses a precomputed replacement process environment.",
  ],
  [
    "src/gateway/live-agent-probes.ts:115:execFile",
    "Live-agent probe runs the OpenClaw CLI under a diagnostic env supplied by the caller.",
  ],
  [
    "src/gateway/server-methods/config.ts:163:execFile",
    "Config-open helper launches the platform opener for user interaction.",
  ],
  [
    "src/hooks/gmail-ops.ts:361:spawn",
    "Gmail hook operation launches the user's gog integration process.",
  ],
  [
    "src/hooks/gmail-watcher.ts:67:spawn",
    "Gmail watcher supervises the user's gog integration process.",
  ],
  [
    "src/infra/process-respawn.ts:27:spawn",
    "Self-respawn intentionally preserves the current process environment for process replacement.",
  ],
  [
    "src/node-host/invoke.ts:152:spawn",
    "Node-host invocation executes a caller-specified command/env on the remote node host.",
  ],
  [
    "src/proxy-capture/ca.ts:23:execFile",
    "Debug proxy certificate generation invokes the trusted openssl binary for local tooling setup.",
  ],
  [
    "src/secrets/resolve.ts:453:spawn",
    "Exec secret providers run with explicit provider-configured env, not inherited process env.",
  ],
  [
    "src/tui/tui-launch.ts:101:spawn",
    "TUI launch is an interactive CLI handoff preserving configured TUI auth env.",
  ],
  [
    "src/tui/tui.ts:886:spawn",
    "Interactive auth login launches the user's local auth CLI with terminal stdio.",
  ],
]);

type ChildProcessCall = {
  relPath: string;
  line: number;
  callee: string;
  text: string;
  context: string;
};

function walkTypescriptFiles(root: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__fixtures__" ||
        entry.name === "fixtures" ||
        entry.name === "test-helpers"
      ) {
        continue;
      }
      out.push(...walkTypescriptFiles(fullPath));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
      continue;
    }
    if (
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".e2e.test.ts") ||
      entry.name.endsWith(".live.test.ts")
    ) {
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function collectProductionSourceFiles(): string[] {
  return walkTypescriptFiles(path.join(repoRoot, SCAN_ROOT)).toSorted();
}

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function isChildProcessModule(specifier: string): boolean {
  return specifier === "node:child_process" || specifier === "child_process";
}

function collectChildProcessBindings(sourceFile: ts.SourceFile): {
  named: Map<string, string>;
  namespaces: Set<string>;
} {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !isChildProcessModule(specifier.text)) {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!bindings) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (CHILD_PROCESS_METHODS.has(imported)) {
        named.set(element.name.text, imported);
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      const initializer = declaration.initializer;
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "promisify" &&
        initializer.arguments.length === 1
      ) {
        const target = initializer.arguments[0];
        if (target && ts.isIdentifier(target)) {
          const method = named.get(target.text);
          if (method && CHILD_PROCESS_METHODS.has(method)) {
            named.set(declaration.name.text, method);
          }
        }
      }
    }
  }
  return { named, namespaces };
}

function resolveChildProcessCallee(
  node: ts.CallExpression,
  bindings: ReturnType<typeof collectChildProcessBindings>,
): string | null {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return bindings.named.get(expression.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    CHILD_PROCESS_METHODS.has(expression.name.text)
  ) {
    return expression.name.text;
  }
  return null;
}

function collectChildProcessCalls(relPath: string, source: string): ChildProcessCall[] {
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const bindings = collectChildProcessBindings(sourceFile);
  const calls: ChildProcessCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = resolveChildProcessCallee(node, bindings);
      if (callee) {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        const { line } = sourceFile.getLineAndCharacterOfPosition(start);
        calls.push({
          relPath,
          line: line + 1,
          callee,
          text: source.slice(start, end),
          context: source.slice(Math.max(0, start - 3_000), end),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function hasReviewedExemption(call: ChildProcessCall): boolean {
  return (
    REVIEWED_NON_OWNED_EXEMPTIONS.has(formatCallLocation(call)) ||
    REVIEWED_EXEMPTION_RE.test(call.context)
  );
}

function hasExplicitEnv(call: ChildProcessCall): boolean {
  return /\benv\s*:/u.test(call.text);
}

function directlyReferencesProcessEnv(call: ChildProcessCall): boolean {
  return (
    /\benv\s*:\s*process\.env\b/u.test(call.text) || /\.\.\.\s*process\.env\b/u.test(call.text)
  );
}

function hasOwnedEnvEvidence(call: ChildProcessCall): boolean {
  return (
    /buildOwnedChildEnv\s*\(/u.test(call.context) || /assertOwnedChildEnv\s*\(/u.test(call.context)
  );
}

function formatCallLocation(call: ChildProcessCall): string {
  return `${call.relPath}:${call.line}:${call.callee}`;
}

describe("owned child process env inventory", () => {
  it("covers every production child_process spawn/exec/fork site with owned env or reviewed exemption", () => {
    const calls = collectProductionSourceFiles().flatMap((fullPath) => {
      const relPath = path.relative(repoRoot, fullPath).split(path.sep).join("/");
      return collectChildProcessCalls(relPath, fs.readFileSync(fullPath, "utf8"));
    });

    const callLocations = calls.map(formatCallLocation).toSorted();
    expect(callLocations).toEqual([
      "src/acp/client.ts:143:spawn",
      "src/agents/mcp-stdio-transport.ts:60:spawn",
      "src/agents/pi-bundle-lsp-runtime.ts:69:spawn",
      "src/agents/sandbox/docker.ts:74:spawn",
      "src/agents/sandbox/ssh.ts:395:spawn",
      "src/agents/sandbox/ssh.ts:451:spawn",
      "src/agents/sandbox/ssh.ts:456:spawn",
      "src/auto-reply/reply/stage-sandbox-media.ts:316:spawn",
      "src/cli/proxy-cli.runtime.ts:107:spawn",
      "src/cli/update-cli/restart-helper.ts:398:spawn",
      "src/cli/update-cli/update-command.ts:1615:spawn",
      "src/cli/update-cli/update-command.ts:1659:spawn",
      "src/commands/doctor-cron.ts:141:execFile",
      "src/commands/doctor-gateway-services.ts:227:execFile",
      "src/commands/doctor-gateway-services.ts:228:execFile",
      "src/commands/doctor-platform-notes.ts:40:execFile",
      "src/crestodian/probes.ts:20:spawn",
      "src/daemon/exec-file.ts:11:execFile",
      "src/daemon/launchd-restart-handoff.ts:204:spawn",
      "src/daemon/schtasks.ts:328:spawn",
      "src/daemon/schtasks.ts:342:spawn",
      "src/entry.ts:115:spawn",
      "src/gateway/live-agent-probes.ts:115:execFile",
      "src/gateway/server-methods/config.ts:163:execFile",
      "src/hooks/gmail-ops.ts:361:spawn",
      "src/hooks/gmail-watcher.ts:67:spawn",
      "src/infra/fs-pinned-path-helper.ts:146:spawn",
      "src/infra/fs-pinned-write-helper.ts:163:spawn",
      "src/infra/machine-name.ts:13:execFile",
      "src/infra/process-respawn.ts:27:spawn",
      "src/infra/ssh-config.ts:75:spawn",
      "src/infra/ssh-tunnel.ts:156:spawn",
      "src/infra/tls/gateway.ts:52:execFile",
      "src/infra/windows-task-restart.ts:83:spawn",
      "src/media/ffmpeg-exec.ts:51:execFile",
      "src/media/ffmpeg-exec.ts:60:execFile",
      "src/media/ffmpeg-exec.ts:87:execFile",
      "src/node-host/invoke.ts:152:spawn",
      "src/process/exec.ts:160:execFile",
      "src/process/exec.ts:298:spawn",
      "src/process/exec.ts:348:spawn",
      "src/process/kill-tree.ts:103:spawn",
      "src/proxy-capture/ca.ts:23:execFile",
      "src/secrets/resolve.ts:453:spawn",
      "src/tui/tui-launch.ts:101:spawn",
      "src/tui/tui.ts:886:spawn",
    ]);
    expect([...REVIEWED_NON_OWNED_EXEMPTIONS.keys()].toSorted()).toEqual(
      callLocations.filter((location) => REVIEWED_NON_OWNED_EXEMPTIONS.has(location)),
    );
    expect(readSource("src/process/spawn-utils.ts")).toContain(
      'assertOwnedChildEnv(options.env, "spawnWithFallback")',
    );

    const failures = calls.flatMap((call) => {
      if (hasReviewedExemption(call)) {
        return [];
      }
      const location = `${call.relPath}:${call.line}`;
      if (!hasExplicitEnv(call)) {
        return [`${location} ${call.callee} lacks explicit env`];
      }
      if (directlyReferencesProcessEnv(call)) {
        return [`${location} ${call.callee} directly inherits process.env`];
      }
      if (!hasOwnedEnvEvidence(call)) {
        return [`${location} ${call.callee} lacks buildOwnedChildEnv/assertOwnedChildEnv evidence`];
      }
      return [];
    });

    expect(failures).toEqual([]);
  });
});
