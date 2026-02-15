/**
 * Compact tool row rendering with security-level badges.
 * Fork-local: kept separate from tool-cards.ts to minimize merge conflicts.
 */
import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import { formatToolOutputForSidebar } from "./tool-helpers.ts";

/* ── Exec Security Classification (mirrors infra/exec-security-level.ts) ── */

type SecurityLevel = "safe" | "low" | "medium" | "high" | "critical";

const SECURITY_DISPLAY: Record<SecurityLevel, { emoji: string; label: string; css: string }> = {
  safe: { emoji: "🟢", label: "SAFE", css: "security--safe" },
  low: { emoji: "🔵", label: "LOW", css: "security--low" },
  medium: { emoji: "🟡", label: "MEDIUM", css: "security--medium" },
  high: { emoji: "🟠", label: "HIGH", css: "security--high" },
  critical: { emoji: "🔴", label: "CRITICAL", css: "security--critical" },
};

const CRITICAL_PATTERNS = [
  "sudo",
  "rm -rf",
  "rm -fr",
  "mkfs",
  "dd if=",
  "dd of=",
  "shred",
  "shutdown",
  "reboot",
  "drop table",
  "drop database",
];
const HIGH_PATTERNS = [
  "systemctl",
  "apt install",
  "apt remove",
  "apt-get",
  "npm install -g",
  "useradd",
  "userdel",
  "chmod -R",
  "chown -R",
  "iptables",
  "ufw",
];
const MEDIUM_PATTERNS = [
  "npm install",
  "npm update",
  "pnpm install",
  "pip install",
  "pip3 install",
  "git push",
  "git pull",
  "git merge",
  "git rebase",
  "git reset",
  "docker",
  "kubectl",
  "ssh ",
  "scp ",
  "rsync",
  "npm run build",
];
const LOW_PATTERNS = [
  "touch",
  "mkdir",
  "cp ",
  "mv ",
  "rm ",
  "git add",
  "git commit",
  "git stash",
  "git checkout",
  "node ",
  "python ",
  "python3 ",
  "make",
  "npm run",
  "sed -i",
  "tar ",
  "zip ",
  "unzip ",
];
const SAFE_PATTERNS = [
  "ls",
  "cat ",
  "head ",
  "tail ",
  "grep ",
  "find ",
  "which ",
  "pwd",
  "whoami",
  "date",
  "echo ",
  "env",
  "git status",
  "git log",
  "git diff",
  "git show",
  "tree",
  "wc ",
  "du ",
  "df ",
  "free",
  "ps ",
  "clawhub",
  "openclaw",
];

function classifyExecCommand(command: string): SecurityLevel {
  const lower = command.trim().toLowerCase();
  for (const p of CRITICAL_PATTERNS) {
    if (lower.includes(p)) {
      return "critical";
    }
  }
  for (const p of HIGH_PATTERNS) {
    if (lower.includes(p)) {
      return "high";
    }
  }
  for (const p of MEDIUM_PATTERNS) {
    if (lower.includes(p)) {
      return "medium";
    }
  }
  for (const p of LOW_PATTERNS) {
    if (lower.includes(p)) {
      return "low";
    }
  }
  for (const p of SAFE_PATTERNS) {
    if (lower.includes(p) || lower.startsWith(p.trim())) {
      return "safe";
    }
  }
  return "medium";
}

/** Check if a tool should render compact — default: ALL tools are compact */
export function isCompactTool(_name: string): boolean {
  return true;
}

/** Merge call+result pairs into single cards (same tool name, adjacent) */
export function mergeToolCards(
  cards: Array<{ kind: "call" | "result"; name: string; args?: unknown; text?: string }>,
): Array<{ kind: "call" | "result"; name: string; args?: unknown; text?: string }> {
  const merged: typeof cards = [];
  const callMap = new Map<string, number>(); // name → index in merged

  for (const card of cards) {
    if (card.kind === "call") {
      callMap.set(card.name, merged.length);
      merged.push({ ...card });
    } else if (card.kind === "result") {
      const callIdx = callMap.get(card.name);
      if (callIdx !== undefined) {
        // Merge into the call card — promote to result with args preserved
        merged[callIdx] = {
          kind: "result",
          name: card.name,
          args: merged[callIdx].args,
          text: card.text,
        };
        callMap.delete(card.name);
      } else {
        merged.push(card);
      }
    }
  }
  return merged;
}

/** Render a compact tool row with optional security badge */
export function renderCompactToolRow(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const toolName = (card.name ?? "").toLowerCase();

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isExec = toolName === "exec";
  const args = (card.args ?? {}) as Record<string, unknown>;
  const command = typeof args.command === "string" ? args.command : "";
  const sec = isExec ? classifyExecCommand(command) : undefined;
  const secInfo = sec ? SECURITY_DISPLAY[sec] : undefined;

  // Build one-liner detail
  let rowDetail = detail ?? "";
  if (isExec && command) {
    rowDetail = command.replace(/\/home\/[^/]+/g, "~").replace(/\/Users\/[^/]+/g, "~");
    if (rowDetail.length > 90) {
      rowDetail = rowDetail.slice(0, 87) + "…";
    }
  }

  const isResult = card.kind === "result";
  const success = isResult && !card.text?.toLowerCase().includes('"error"');
  const statusIcon = isResult ? (success ? "✓" : "✗") : "⋯";
  const statusClass = isResult ? (success ? "status--ok" : "status--err") : "status--run";

  return html`
    <div
      class="tool-row ${canClick ? "tool-row--clickable" : ""} ${secInfo?.css ?? ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
    >
      <span class="tool-row__status ${statusClass}">${statusIcon}</span>
      ${secInfo ? html`<span class="tool-row__sec">${secInfo.emoji}</span>` : html`<span class="tool-row__icon">${icons[display.icon]}</span>`}
      <span class="tool-row__label">${display.label}</span>
      ${display.verb ? html`<span class="tool-row__verb">${display.verb}</span>` : nothing}
      <span class="tool-row__detail mono">${rowDetail}</span>
      ${secInfo ? html`<span class="tool-row__level">${secInfo.label}</span>` : nothing}
      ${
        canClick && hasText
          ? html`
              <span class="tool-row__view">▸</span>
            `
          : nothing
      }
    </div>
  `;
}

/* ── Collapsible System Messages ── */

/** Extract a one-line summary from a system message */
function summarizeSystemMessage(text: string): { summary: string; detail: string | null } {
  const trimmed = text.trim();

  // GatewayRestart JSON
  const restartMatch = trimmed.match(/^(System:.*?GatewayRestart:)\s*\{/s);
  if (restartMatch) {
    // Extract reason from JSON if possible
    const reasonMatch = trimmed.match(/"reason"\s*:\s*"([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "restarting";
    const tsMatch = trimmed.match(/\[(.*?)\]/);
    const ts = tsMatch ? tsMatch[1] : "";
    return {
      summary: `🔄 Gateway restart: ${reason}${ts ? ` (${ts})` : ""}`,
      detail: trimmed,
    };
  }

  // Config apply
  if (trimmed.includes('"kind": "config-apply"') || trimmed.includes('"kind":"config-apply"')) {
    const tsMatch = trimmed.match(/\[(.*?)\]/);
    const ts = tsMatch ? tsMatch[1] : "";
    return {
      summary: `⚙️ Config applied${ts ? ` (${ts})` : ""}`,
      detail: trimmed,
    };
  }

  // Exec completed
  const execMatch = trimmed.match(
    /^(System:.*?Exec completed \(([^,]+), code (\d+)\))\s*::\s*(.*)/s,
  );
  if (execMatch) {
    const session = execMatch[2];
    const code = execMatch[3];
    const icon = code === "0" ? "✓" : "✗";
    const tsMatch = trimmed.match(/\[(.*?)\]/);
    const ts = tsMatch ? tsMatch[1] : "";
    return {
      summary: `${icon} Exec completed (${session}, code ${code})${ts ? ` — ${ts}` : ""}`,
      detail: execMatch[4]?.trim() || null,
    };
  }

  // WhatsApp connected
  if (trimmed.includes("WhatsApp gateway connected")) {
    const tsMatch = trimmed.match(/\[(.*?)\]/);
    const ts = tsMatch ? tsMatch[1] : "";
    return {
      summary: `📱 WhatsApp connected${ts ? ` (${ts})` : ""}`,
      detail: null,
    };
  }

  // Short messages — no collapsing needed
  if (trimmed.length < 120) {
    return { summary: trimmed, detail: null };
  }

  // Fallback: first line as summary
  const firstLine = trimmed.split("\n")[0].slice(0, 100);
  return {
    summary: firstLine + (trimmed.length > 100 ? "…" : ""),
    detail: trimmed,
  };
}

/** Render a collapsible system message */
export function renderCollapsibleSystem(text: string) {
  const { summary, detail } = summarizeSystemMessage(text);

  if (!detail) {
    return html`<span class="sys-line">${summary}</span>`;
  }

  const handleClick = (e: Event) => {
    const target = e.currentTarget as HTMLElement;
    const summaryEl = target.querySelector(".sys-summary");
    const detailEl = target.querySelector(".sys-detail");
    if (summaryEl && detailEl) {
      summaryEl.classList.toggle("expanded");
      detailEl.classList.toggle("visible");
    }
  };

  return html`
    <div @click=${handleClick} style="cursor:pointer">
      <div class="sys-summary">
        <span class="sys-summary__chevron">▶</span>
        <span>${summary}</span>
      </div>
      <div class="sys-detail">${detail}</div>
    </div>
  `;
}
