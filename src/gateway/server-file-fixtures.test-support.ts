import { expect } from "vitest";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Preserve fixture identity through module resets, within the current test file only. */
export function resolveGatewayTestFileFixture<T>(key: symbol, create: () => T): T {
  const testPath = expect.getState().testPath;
  if (!testPath) {
    throw new Error("Gateway test fixtures require an active Vitest file");
  }
  const fixture = resolveGlobalSingleton(key, () => ({ testPath, value: create() }));
  if (fixture.testPath !== testPath) {
    fixture.value = create();
    fixture.testPath = testPath;
  }
  return fixture.value;
}
