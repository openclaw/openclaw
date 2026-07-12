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

type LocalShellSessionScope = { sessionKey: string; agentId?: string };

type LocalShellConsent = {
  asked: boolean;
  allowed: boolean;
  share: boolean;
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
  getSessionScope?: () => LocalShellSessionScope | undefined;
  /** Persists the command+output to session history; only called after the user picks the
   * share option at the consent prompt. `!` sets excludeFromContext: false so the agent sees
   * it on its next turn; `!!` sets it true so it stays in scrollback/history only. The scope
   * is the one captured when the command was submitted, never the currently viewed session. */
  injectBashExecution?: (
    result: LocalShellExecutionResult,
    scope: LocalShellSessionScope,
  ) => Promise<{ ok: boolean; error?: string }>;
};

export function createLocalShellRunner(deps: LocalShellDeps) {
  // Consent is per agent+session identity, and sharing is opt-in: without the
  // share answer `!`/`!!` stay purely local (the shipped pre-persistence
  // behavior). Approval granted while one session is active must never
  // silently carry into another, and the session key alone is not enough:
  // shared keys like "global" keep the same sessionKey across an agent
  // switch, so the key must include the agent or approval leaks across the
  // agent boundary.
  const consentBySession = new Map<string, LocalShellConsent>();
  const consentKeyFor = (scope: LocalShellSessionScope | undefined): string =>
    scope ? `${scope.agentId ?? ""}\u0000${scope.sessionKey}` : "";
  const consentFor = (scope: LocalShellSessionScope | undefined): LocalShellConsent => {
    const key = consentKeyFor(scope);
    const existing = consentBySession.get(key);
    if (existing) {
      return existing;
    }
    const created: LocalShellConsent = { asked: false, allowed: false, share: false };
    consentBySession.set(key, created);
    return created;
  };
  const createSelector = deps.createSelector ?? createSearchableSelectList;
  const spawnCommand = deps.spawnCommand ?? spawn;
  const getCwd = deps.getCwd ?? tryProcessCwd;
  const env = deps.env ?? process.env;
  const maxChars = deps.maxOutputChars ?? 40_000;

  const ensureLocalExecAllowed = async (consent: LocalShellConsent): Promise<boolean> => {
    if (consent.allowed) {
      return true;
    }
    if (consent.asked) {
      return false;
    }
    consent.asked = true;

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
          consent.allowed = true;
          consent.share = item.value === "yes-share";
          deps.chatLog.addSystem(
            consent.share
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

    // Bind consent and the persistence target to the session that was active
    // when the command was submitted. A mid-command `/session` switch must not
    // retarget the output: persisting into the newly selected session would
    // hand this session's (possibly sensitive) output to the wrong agent.
    const scope = deps.getSessionScope?.();
    const consent = consentFor(scope);

    if (consent.asked && !consent.allowed) {
      deps.chatLog.addSystem("local shell: not enabled for this session");
      deps.tui.requestRender();
      return;
    }

    const allowed = await ensureLocalExecAllowed(consent);
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

    // Streamed chunks are capped as they arrive, so the retained strings can
    // never exceed maxChars: a length check at close time misses a single
    // overflowing stream entirely. Record the loss here, where it happens.
    let overflowed = false;
    const appendWithCap = (text: string, chunk: string) => {
      const combined = text + chunk;
      if (combined.length <= maxChars) {
        return combined;
      }
      overflowed = true;
      return sliceUtf16Safe(combined, -maxChars);
    };

    const persistResult = async (
      result: Omit<LocalShellExecutionResult, "command" | "excludeFromContext">,
    ) => {
      if (!consent.share || !scope || !deps.injectBashExecution) {
        return;
      }
      const persisted = await deps.injectBashExecution(
        {
          ...result,
          command: cmd,
          excludeFromContext: isBangBang,
        },
        scope,
      );
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
          truncated: overflowed || uncapped.length > maxChars,
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
