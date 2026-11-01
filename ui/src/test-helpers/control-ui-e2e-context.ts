import type { JSHandle, Page } from "playwright";
import type { ApplicationContext } from "../app/context.ts";

/** Caller disposes this handle and reacquires it after application context replacement. */
export async function getControlUiContextHandle(page: Page): Promise<JSHandle<ApplicationContext>> {
  return page.evaluateHandle(() => {
    const root = document.querySelector("openclaw-app");
    const target = root?.querySelector("openclaw-app-shell") ?? root?.firstElementChild;
    if (!target) {
      throw new Error("Control UI context consumer is unavailable");
    }
    const received: { value?: ApplicationContext } = {};
    // ContextRequestEvent is a bubbling event with these public protocol fields.
    // Keep the browser callback self-contained for bundled and dev-server E2E.
    target.dispatchEvent(
      Object.assign(
        new Event("context-request", {
          bubbles: true,
          composed: true,
        }),
        {
          context: "openclaw.application",
          contextTarget: target,
          subscribe: false,
          callback: (context: ApplicationContext) => {
            received.value = context;
          },
        },
      ),
    );
    if (!received.value) {
      throw new Error("Control UI application context is unavailable");
    }
    return received.value;
  });
}

declare const contextHandle: JSHandle<ApplicationContext>;
type ContextEvaluation<Result, Arg> = Exclude<
  Parameters<typeof contextHandle.evaluate<Result, Arg, ApplicationContext>>[0],
  string
>;

/** Use the application's existing DOM context boundary without exposing its runtime. */
export function evaluateControlUiContext<Result>(
  page: Page,
  callback: (context: ApplicationContext) => Result | Promise<Result>,
): Promise<Awaited<Result>>;
export function evaluateControlUiContext<Result, Arg>(
  page: Page,
  callback: ContextEvaluation<Result, Arg>,
  arg: Arg,
): Promise<Awaited<Result>>;
export async function evaluateControlUiContext<Result, Arg>(
  page: Page,
  ...evaluation:
    | [callback: (context: ApplicationContext) => Result | Promise<Result>]
    | [callback: ContextEvaluation<Result, Arg>, arg: Arg]
): Promise<Awaited<Result>> {
  const context = await getControlUiContextHandle(page);
  try {
    if (evaluation.length === 1) {
      return await context.evaluate(evaluation[0]);
    }
    return await context.evaluate<Result, Arg, ApplicationContext>(...evaluation);
  } finally {
    await context.dispose();
  }
}
