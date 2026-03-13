import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandSecurityResult = {
  action: "allow" | "warn" | "block";
  findings: Array<{ rule_id: string; severity: string; title: string; description: string }>;
  summary: string;
};

export type CommandSecurityConfig = {
  enabled: boolean;
  failOpen: boolean;
  timeoutMs: number;
  tirithPath: string;
};

const DEFAULT_CONFIG: CommandSecurityConfig = {
  enabled: true,
  failOpen: true,
  timeoutMs: 5000,
  tirithPath: "tirith",
};

export async function checkCommandSecurity(
  command: string,
  config?: Partial<CommandSecurityConfig>,
  options?: { shell?: string; env?: Record<string, string> },
): Promise<CommandSecurityResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) {
    return { action: "allow", findings: [], summary: "" };
  }

  const shell = options?.shell ?? "posix";
  let tirithPath = cfg.tirithPath;
  // Expand ~ prefix
  if (tirithPath.startsWith("~/")) {
    tirithPath = os.homedir() + tirithPath.slice(1);
  }

  const args = ["check", "--json", "--non-interactive", "--shell", shell, "--", command];
  const execOpts: { timeout: number; env?: Record<string, string> } = {
    timeout: cfg.timeoutMs,
  };
  if (options?.env) {
    execOpts.env = options.env;
  }

  try {
    await execFileAsync(tirithPath, args, execOpts);
    // Exit 0 = allow
    return { action: "allow", findings: [], summary: "" };
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    // Spawn error (ENOENT, etc.)
    if (typeof e.code === "string") {
      const action = cfg.failOpen ? "allow" : "block";
      const summary = cfg.failOpen
        ? ""
        : `tirith could not be started at "${tirithPath}" (${e.code})`;
      return { action, findings: [], summary };
    }

    // Timeout
    if (e.killed) {
      const action = cfg.failOpen ? "allow" : "block";
      const summary = cfg.failOpen ? "" : "tirith: security check timed out";
      return { action, findings: [], summary };
    }

    const exitCode = typeof e.code === "number" ? e.code : undefined;

    // Parse findings from stdout
    let findings: CommandSecurityResult["findings"] = [];
    let summary = "";
    let jsonParseFailed = false;
    const stdout: string = (e.stdout as string) || "";
    if (stdout.trim()) {
      try {
        const verdict = JSON.parse(stdout);
        findings = (verdict.findings || []).slice(0, 50).map((f: Record<string, unknown>) => ({
          rule_id: (f.rule_id as string) || "",
          severity: (f.severity as string) || "",
          title: (f.title as string) || "",
          description: (f.description as string) || "",
        }));
        if (findings.length > 0) {
          summary = findings
            .map((f) => {
              return f.severity ? `[${f.severity}] ${f.title}` : f.title;
            })
            .join("; ")
            .slice(0, 500);
        }
      } catch {
        jsonParseFailed = true;
        if (exitCode === 1 || exitCode === 2) {
          summary = stdout.trim().slice(0, 500);
        }
      }
    }

    // Exit 1 = block (honor even with malformed JSON — scanner's intent is clear)
    if (exitCode === 1) {
      return { action: "block", findings, summary: summary || "command blocked by tirith" };
    }

    // Exit 2 = warn. If JSON parsing failed or findings array is empty, the
    // warning can't be properly surfaced to host integrations (which gate on
    // findings.length > 0). Treat as a scanner error and apply failOpen.
    if (exitCode === 2) {
      if (jsonParseFailed || findings.length === 0) {
        const action = cfg.failOpen ? "allow" : "block";
        const fallbackSummary = cfg.failOpen
          ? ""
          : summary || "tirith: warning with no parseable findings";
        return { action, findings: [], summary: fallbackSummary };
      }
      return { action: "warn", findings, summary: summary || "command flagged by tirith" };
    }

    // Unknown exit code or no exit code
    const action = cfg.failOpen ? "allow" : "block";
    const fallbackSummary = cfg.failOpen ? "" : `tirith: unexpected exit code ${exitCode}`;
    return { action, findings: [], summary: fallbackSummary };
  }
}
