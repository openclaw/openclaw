import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  prepareE2eVitestRuntime,
  runE2eGlobalSetup,
} from "../../scripts/lib/vitest-build-prerequisites.mts";

it("consumes the prepared private-QA runtime without replacing its generation", async () => {
  expect(process.env.OPENCLAW_E2E_USE_PREBUILT_DIST).toBe("1");
  const stamps = LOCAL_BUILD_METADATA_DIST_PATHS.map((file) => ({
    file,
    bytes: readFileSync(file),
    mtimeMs: statSync(file).mtimeMs,
  }));

  await prepareE2eVitestRuntime(process.env);
  await runE2eGlobalSetup(undefined, process.env);

  // This private-only entry proves qaRuntime published usable QA artifacts.
  const { parseQaTarget } = await import(
    pathToFileURL(path.resolve("dist/plugin-sdk/qa-channel-protocol.js")).href
  );
  expect(parseQaTarget("channel:prepared-runtime")).toEqual({
    chatType: "channel",
    conversationId: "prepared-runtime",
  });
  const { createApiRegistry } = await import(
    pathToFileURL(path.resolve("packages/ai/dist/index.mjs")).href
  );
  expect(createApiRegistry().getApiProviders()).toEqual([]);
  for (const { file, bytes, mtimeMs } of stamps) {
    expect(readFileSync(file)).toEqual(bytes);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
  }
});
