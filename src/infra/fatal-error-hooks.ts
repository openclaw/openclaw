type FatalErrorHookContext = {
  reason: string;
  error?: unknown;
};

/** Hook that can return one extra diagnostic line for fatal error output. */
type FatalErrorHook = (context: FatalErrorHookContext) => string | undefined | void;

let fatalHook: FatalErrorHook | undefined;

export function setFatalErrorHook(hook: FatalErrorHook | undefined): void {
  fatalHook = hook;
}

export function runFatalErrorHooks(context: FatalErrorHookContext): string[] {
  try {
    const message = fatalHook?.(context);
    return typeof message === "string" && message.trim() ? [message] : [];
  } catch (err) {
    // Fatal output must keep progressing even if the diagnostic hook itself throws.
    const name = err instanceof Error && err.name ? err.name : "unknown";
    return [`fatal-error hook failed: ${name}`];
  }
}
