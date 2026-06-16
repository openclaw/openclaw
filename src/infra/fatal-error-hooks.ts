/** Context passed to fatal-error hooks before the process exits. */
import { spawn } from "node:child_process";

type FatalErrorHookContext = {
  reason: string;
  error?: unknown;
};

/** Hook that can return one extra diagnostic line for fatal error output. */
type FatalErrorHook = (context: FatalErrorHookContext) => string | undefined | void;

const hooks = new Set<FatalErrorHook>();

function formatHookFailure(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "unknown";
  return `fatal-error hook failed: ${name}`;
}

export function registerFatalErrorHook(hook: FatalErrorHook): () => void {
  hooks.add(hook);
  return () => { hooks.delete(hook); };
}

function runExternalErrorHandler(context: FatalErrorHookContext): void {
  const handler = process.env.OPENCLAW_ERROR_HANDLER?.trim();
  if (!handler) return;

  try {
    const payload: Record<string, unknown> = {
      schemaVersion: 1,
      reason: context.reason,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    };

    const child = spawn(handler, [JSON.stringify(payload)], {
      stdio: "ignore",
      detached: true,
      shell: false,
    });

    child.on("error", () => {});
    child.unref();
  } catch (err) {
    console.error("[fatal-error-hooks] OPENCLAW_ERROR_HANDLER failed:", String(err));
  }
}

export function runFatalErrorHooks(context: FatalErrorHookContext): string[] {
  const messages: string[] = [];
  for (const hook of hooks) {
    try {
      const message = hook(context);
      if (typeof message === "string" && message.trim()) {
        messages.push(message);
      }
    } catch (err) {
      messages.push(formatHookFailure(err));
    }
  }
  runExternalErrorHandler(context);
  return messages;
}

export function resetFatalErrorHooksForTest(): void {
  hooks.clear();
}

