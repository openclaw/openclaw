// Launches and manages the local shell process used by TUI local mode.
import { spawn } from "node:child_process";
import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { createSearchableSelectList } from "./components/selectors.js";

type LocalShellExecutionResult = {
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  excludeFromContext: boolean;
};

type LocalShellDeps = {
  chatLog: {
    addSystem: (line: string) => void;
  };
  tui: {
    requestRender: () => void;
  };
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  createSelector?: (
    items: SelectItem[],
    maxVisible: number,
  ) => Component & {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  spawnCommand?: typeof spawn;
  getCwd?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  maxOutputChars?: number;
  /** Session scope to persist the command result under. Omit to skip persistence entirely. */
  getSessionScope?: () => { sessionKey: string; agentId?: string } | undefined;
  /** Persists the command+output to session history; only called after the user picks the
   * share option at the consent prompt. `!` sets excludeFromContext: false so the agent sees
   * it on its next turn; `!!` sets it true so it stays in scrollback/history only. */
  injectBashExecution?: (
    result: LocalShellExecutionResult,
  ) => Promise<{ ok: boolean; error?: string }>;
};

export function createLocalShellRunner(deps: LocalShellDeps) {
  let localExecAsked = false;
  let localExecAllowed = false;
  // Sharing is opt-in per session: without it `!`/`!!` stay purely local (the
  // shipped pre-persistence behavior) and no output reaches history or the model.
  let persistAllowed = false;
  const createSelector = deps.createSelector ?? createSearchableSelectList;
  const spawnCommand = deps.spawnCommand ?? spawn;
  const getCwd = deps.getCwd ?? tryProcessCwd;
  const env = deps.env ?? process.env;
  const maxChars = deps.maxOutputChars ?? 40_000;

  const ensureLocalExecAllowed = async (): Promise<boolean> => {
    if (localExecAllowed) {
      return true;
    }
    if (localExecAsked) {
      return false;
    }
    localExecAsked = true;

    return await new Promise<boolean>((resolve) => {
      deps.chatLog.addSystem("Allow local shell commands for this session?");
      deps.chatLog.addSystem(
        "This runs commands on YOUR machine (not the gateway) and may delete files or reveal secrets.",
      );
      deps.chatLog.addSystem(
        "Sharing also saves commands+output to session history; the agent sees `!` output next turn (`!!` stays history-only).",
      );
      deps.chatLog.addSystem("Select an option (arrows + Enter), Esc to cancel.");
      const selector = createSelector(
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes, local only" },
          { value: "yes-share", label: "Yes, and share with the agent" },
        ],
        3,
      );
      selector.onSelect = (item) => {
        deps.closeOverlay(overlayHandle);
        if (item.value === "yes" || item.value === "yes-share") {
          localExecAllowed = true;
          persistAllowed = item.value === "yes-share";
          deps.chatLog.addSystem(
            persistAllowed
              ? "local shell: enabled; output is saved to history and `!` output is shared with the agent"
              : "local shell: enabled for this session (local only)",
          );
          resolve(true);
        } else {
          deps.chatLog.addSystem("local shell: not enabled");
          resolve(false);
        }
        deps.tui.requestRender();
      };
      selector.onCancel = () => {
        deps.closeOverlay(overlayHandle);
        deps.chatLog.addSystem("local shell: cancelled");
        deps.tui.requestRender();
        resolve(false);
      };
      const overlayHandle: OverlayHandle = deps.openOverlay(selector);
      deps.tui.requestRender();
    });
  };

  const runLocalShellLine = async (line: string) => {
    // '!!' means "history-only, keep it out of the agent's context" (excludeFromContext);
    // plain '!' means "agent-visible next turn" (Claude Code's own `!` convention).
    const isBangBang = line.startsWith("!!");
    const cmd = isBangBang ? line.slice(2) : line.slice(1);
    // NOTE: A lone '!' or '!!' is handled by the submit handler as a normal message.
    // Keep this guard anyway in case this is called directly.
    if (cmd === "") {
      return;
    }

    if (localExecAsked && !localExecAllowed) {
      deps.chatLog.addSystem("local shell: not enabled for this session");
      deps.tui.requestRender();
      return;
    }

    const allowed = await ensureLocalExecAllowed();
    if (!allowed) {
      return;
    }

    // A shell command's meaning depends on its directory; never retarget it implicitly.
    const cwd = getCwd();
    if (!cwd) {
      deps.chatLog.addSystem(
        "local shell: working directory was deleted; cd to an existing directory first",
      );
      deps.tui.requestRender();
      return;
    }

    deps.chatLog.addSystem(`[local] $ ${cmd}`);
    deps.tui.requestRender();

    const appendWithCap = (text: string, chunk: string) => {
      const combined = text + chunk;
      return combined.length > maxChars ? sliceUtf16Safe(combined, -maxChars) : combined;
    };

    const persistResult = async (
      result: Omit<LocalShellExecutionResult, "command" | "excludeFromContext">,
    ) => {
      const scope = deps.getSessionScope?.();
      if (!persistAllowed || !scope || !deps.injectBashExecution) {
        return;
      }
      const persisted = await deps.injectBashExecution({
        ...result,
        command: cmd,
        excludeFromContext: isBangBang,
      });
      if (!persisted.ok) {
        deps.chatLog.addSystem(
          `[local] not saved to session history: ${persisted.error ?? "unknown error"}`,
        );
        deps.tui.requestRender();
      }
    };

    await new Promise<void>((resolve) => {
      const child = spawnCommand(cmd, {
        // Intentionally a shell: this is an operator-only local TUI feature (prefixed with `!`)
        // and is gated behind an explicit in-session approval prompt.
        shell: true,
        cwd,
        env: { ...env, OPENCLAW_SHELL: "tui-local" },
      });

      let stdout = "";
      let stderr = "";
      // Output pipes may fail independently; child close/error remains authoritative.
      const ignoreOutputStreamError = () => {};
      child.stdout.on("error", ignoreOutputStreamError);
      child.stderr.on("error", ignoreOutputStreamError);
      child.stdout.on("data", (buf) => {
        stdout = appendWithCap(stdout, buf.toString("utf8"));
      });
      child.stderr.on("data", (buf) => {
        stderr = appendWithCap(stderr, buf.toString("utf8"));
      });

      // A failed spawn emits both 'error' and a subsequent 'close'; guard so
      // only the first terminal event persists/resolves the run.
      let settled = false;

      const handleClose = async (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        // Keep the tail (consistent with the streaming appendWithCap above) so a
        // large stdout cannot evict stderr: the failure reason (FATAL etc.) at the
        // end is what the operator needs most when output overflows the cap.
        const uncapped = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
        const combined = sliceUtf16Safe(uncapped, -maxChars).trimEnd();

        if (combined) {
          for (const lineLocal of combined.split("\n")) {
            deps.chatLog.addSystem(`[local] ${lineLocal}`);
          }
        }
        deps.chatLog.addSystem(`[local] exit ${code ?? "?"}${signal ? ` (signal ${signal})` : ""}`);
        deps.tui.requestRender();
        await persistResult({
          output: combined,
          exitCode: code ?? undefined,
          cancelled: signal != null,
          truncated: uncapped.length > maxChars,
        });
        resolve();
      };

      const handleError = async (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        deps.chatLog.addSystem(`[local] error: ${String(err)}`);
        deps.tui.requestRender();
        await persistResult({
          output: `error: ${String(err)}`,
          cancelled: false,
          truncated: false,
        });
        resolve();
      };

      child.on("close", (code, signal) => {
        void handleClose(code, signal);
      });
      child.on("error", (err) => {
        void handleError(err);
      });
    });
  };

  return { runLocalShellLine };
}
