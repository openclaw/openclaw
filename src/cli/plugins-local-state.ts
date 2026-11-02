import { runWithLocalStateOwner } from "./local-state-owner.js";

/** Local plugin writers use the same offline ownership boundary as config commands. */
export async function runWithLocalPluginState<T>(
  command: string,
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  return await runWithLocalStateOwner({
    method: `plugins.${command}`,
    params: {},
    target: `openclaw plugins ${command}`,
    onForeignOwner: "refuse",
    runLocal: ({ assertCurrent }) => run(assertCurrent),
  });
}
