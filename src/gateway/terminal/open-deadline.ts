import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { toErrorObject } from "../../infra/errors.js";

export const TERMINAL_OPEN_DEADLINE_MS = 30_000;

export class TerminalOpenDeadlineError extends Error {
  constructor() {
    super("terminal open timed out");
    this.name = "TerminalOpenDeadlineError";
  }
}

type TerminalOpenDeadline = {
  expiresAtMs: number;
  controller: AbortController;
};

export function createTerminalOpenDeadline(): TerminalOpenDeadline {
  return {
    expiresAtMs: Date.now() + TERMINAL_OPEN_DEADLINE_MS,
    controller: new AbortController(),
  };
}

function expireTerminalOpenDeadline(deadline: TerminalOpenDeadline): Error {
  if (!deadline.controller.signal.aborted) {
    deadline.controller.abort(new TerminalOpenDeadlineError());
  }
  return toErrorObject(deadline.controller.signal.reason, "Terminal open timed out");
}

export async function waitForTerminalOpenDeadline<T>(
  run: () => Promise<T>,
  deadline: TerminalOpenDeadline,
): Promise<T> {
  if (deadline.controller.signal.aborted || Date.now() >= deadline.expiresAtMs) {
    throw expireTerminalOpenDeadline(deadline);
  }
  const expire = () => {
    throw expireTerminalOpenDeadline(deadline);
  };
  const assertCurrent = () => {
    if (deadline.controller.signal.aborted || Date.now() >= deadline.expiresAtMs) {
      expire();
    }
  };
  return await raceWithTimeout(
    async () => {
      try {
        const result = await run();
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        throw toErrorObject(error, "Terminal open failed");
      }
    },
    Math.max(0, deadline.expiresAtMs - Date.now()),
    expire,
    { signal: deadline.controller.signal, onAbort: expire },
  );
}
