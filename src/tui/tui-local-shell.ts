import { spawn } from "node:child_process";
import type { Component, SelectItem } from "@mariozechner/pi-tui";
import { decodeWindowsOutputBuffer } from "../infra/windows-encoding.js";
import { createSearchableSelectList } from "./components/selectors.js";

type LocalShellDeps = {
  chatLog: {
    addSystem: (line: string) => void;
  };
  tui: {
    requestRender: () => void;
  };
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  createSelector?: (
    items: SelectItem[],
    maxVisible: number,
  ) => Component & {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  spawnCommand?: typeof spawn;
  decodeOutputBuffer?: typeof decodeWindowsOutputBuffer;
  getCwd?: () => string;
  env?: NodeJS.ProcessEnv;
  maxOutputChars?: number;
};

export function createLocalShellRunner(deps: LocalShellDeps) {
  let localExecAsked = false;
  let localExecAllowed = false;
  const createSelector = deps.createSelector ?? createSearchableSelectList;
  const spawnCommand = deps.spawnCommand ?? spawn;
  const decodeOutputBuffer = deps.decodeOutputBuffer ?? decodeWindowsOutputBuffer;
  const getCwd = deps.getCwd ?? (() => process.cwd());
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
      deps.chatLog.addSystem("Select Yes/No (arrows + Enter), Esc to cancel.");
      const selector = createSelector(
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ],
        2,
      );
      selector.onSelect = (item) => {
        deps.closeOverlay();
        if (item.value === "yes") {
          localExecAllowed = true;
          deps.chatLog.addSystem("local shell: enabled for this session");
          resolve(true);
        } else {
          deps.chatLog.addSystem("local shell: not enabled");
          resolve(false);
        }
        deps.tui.requestRender();
      };
      selector.onCancel = () => {
        deps.closeOverlay();
        deps.chatLog.addSystem("local shell: cancelled");
        deps.tui.requestRender();
        resolve(false);
      };
      deps.openOverlay(selector);
      deps.tui.requestRender();
    });
  };

  const runLocalShellLine = async (line: string) => {
    const cmd = line.slice(1);
    // NOTE: A lone '!' is handled by the submit handler as a normal message.
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

    deps.chatLog.addSystem(`[local] $ ${cmd}`);
    deps.tui.requestRender();

    const appendWithCap = (text: string, chunk: string) => {
      const combined = text + chunk;
      return combined.length > maxChars ? combined.slice(-maxChars) : combined;
    };

    await new Promise<void>((resolve) => {
      const child = spawnCommand(cmd, {
        // Intentionally a shell: this is an operator-only local TUI feature (prefixed with `!`)
        // and is gated behind an explicit in-session approval prompt.
        shell: true,
        cwd: getCwd(),
        env: { ...env, OPENCLAW_SHELL: "tui-local" },
      });

      let stdoutBuffer = Buffer.alloc(0);
      let stderrBuffer = Buffer.alloc(0);
      child.stdout.on("data", (buf) => {
        stdoutBuffer = appendBufferWithByteCap(stdoutBuffer, buf, maxChars);
      });
      child.stderr.on("data", (buf) => {
        stderrBuffer = appendBufferWithByteCap(stderrBuffer, buf, maxChars);
      });

      child.on("close", (code, signal) => {
        const stdout = appendWithCap("", decodeOutputBuffer({ buffer: stdoutBuffer }));
        const stderr = appendWithCap("", decodeOutputBuffer({ buffer: stderrBuffer }));
        const combined = (stdout + (stderr ? (stdout ? "\n" : "") + stderr : ""))
          .slice(0, maxChars)
          .trimEnd();

        if (combined) {
          for (const line of combined.split("\n")) {
            deps.chatLog.addSystem(`[local] ${line}`);
          }
        }
        deps.chatLog.addSystem(`[local] exit ${code ?? "?"}${signal ? ` (signal ${signal})` : ""}`);
        deps.tui.requestRender();
        resolve();
      });

      child.on("error", (err) => {
        deps.chatLog.addSystem(`[local] error: ${String(err)}`);
        deps.tui.requestRender();
        resolve();
      });
    });
  };

  return { runLocalShellLine };
}

function appendBufferWithByteCap(
  current: Buffer,
  chunk: Buffer | string | Uint8Array,
  maxChars: number,
): Buffer {
  const appended = Buffer.concat([current, outputChunkToBuffer(chunk)]);
  const maxBytes = Math.max(0, Math.floor(maxChars)) * 4 + 8;
  return appended.length <= maxBytes ? appended : appended.subarray(appended.length - maxBytes);
}

function outputChunkToBuffer(chunk: Buffer | string | Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(chunk);
}
