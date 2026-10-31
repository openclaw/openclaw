import { prepareUpdateCommandTerminalResult } from "./update-command-terminal.js";

export async function publishUpdateCommandTerminalResultForTest(
  params: Parameters<typeof prepareUpdateCommandTerminalResult>[0],
  input: Parameters<typeof prepareUpdateCommandTerminalResult>[1],
  outcome: Parameters<typeof prepareUpdateCommandTerminalResult>[2],
  onTerminalRecord?: Parameters<Awaited<ReturnType<typeof prepareUpdateCommandTerminalResult>>>[0],
) {
  const publish = await prepareUpdateCommandTerminalResult(params, input, outcome);
  return publish(onTerminalRecord);
}
