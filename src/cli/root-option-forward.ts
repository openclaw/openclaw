import { consumeRootOptionToken } from "../infra/cli-root-options.js";

/** Copy a recognized root-level CLI option and any value token into a forwarded argv list. */
export function forwardConsumedCliRootOption(
  args: readonly string[],
  index: number,
  out: string[],
): number {
  const consumedRootOption = consumeRootOptionToken(args, index);
  if (consumedRootOption <= 0) {
    return 0;
  }

  for (let offset = 0; offset < consumedRootOption; offset += 1) {
    const token = args[index + offset];
    if (token !== undefined) {
      out.push(token);
    }
  }

  return consumedRootOption;
}
