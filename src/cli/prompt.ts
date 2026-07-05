// Small interactive prompt helpers for CLI confirmations.
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isVerbose, isYes } from "../globals.js";
<<<<<<< HEAD
import { toErrorObject } from "../infra/errors.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/** Signals that an interactive prompt lost stdin before a complete answer arrived. */
export class PromptInputClosedError extends Error {
  constructor() {
    super("Prompt input closed before an answer was received.");
    this.name = "PromptInputClosedError";
  }
}

type ReadlineInterface = ReturnType<typeof readline.createInterface>;

function questionUntilClose(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      rl.off("close", onClose);
      complete();
    };
    const onClose = () => finish(() => reject(new PromptInputClosedError()));

    // readline.question does not reject on interface close, so race it with the close event.
    rl.once("close", onClose);
    void rl.question(question).then(
      (answer) => finish(() => resolve(answer)),
<<<<<<< HEAD
      (error: unknown) => finish(() => reject(toErrorObject(error, "Non-Error rejection"))),
=======
      (error: unknown) => finish(() => reject(toLintErrorObject(error, "Non-Error rejection"))),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    );
  });
}

/** Prompts for yes/no input, honoring global `--yes` before opening stdin. */
export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  if (isVerbose() && isYes()) {
    return true;
  }
  if (isYes()) {
    return true;
  }
  const rl = readline.createInterface({ input, output });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = normalizeLowercaseStringOrEmpty(
    await questionUntilClose(rl, `${question}${suffix}`).finally(() => {
      rl.close();
    }),
  );
  if (!answer) {
    return defaultYes;
  }
  return answer.startsWith("y");
}

<<<<<<< HEAD
export async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return await questionUntilClose(rl, question).finally(() => {
    rl.close();
  });
=======
function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}
