type FatalErrorHookContext = {
  reason: string;
  error?: unknown;
};

/** Hook that can return one extra diagnostic line for fatal error output. */
type FatalErrorHook = (context: FatalErrorHookContext) => string | undefined | void;

const hooks = new Set<FatalErrorHook>();

export function registerFatalErrorHook(hook: FatalErrorHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
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
      // Fatal output must keep progressing even if a diagnostic hook itself throws.
      const name = err instanceof Error && err.name ? err.name : "unknown";
      messages.push(`fatal-error hook failed: ${name}`);
    }
  }
  return messages;
}
