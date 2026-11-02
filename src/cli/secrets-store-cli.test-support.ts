import type { runWithLocalStateOwner as RunOwner } from "./local-state-owner.js";

// Policy suites exercise local custody; owner routing has separate boundary proof.
export async function runWithLocalStateOwner({ runLocal }: Parameters<typeof RunOwner>[0]) {
  return runLocal({
    env: process.env,
    config: {},
    signal: new AbortController().signal,
    assertCurrent() {},
  });
}
