import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const launcherUrl = new URL("../../openclaw.mjs", import.meta.url);

function loadDirectModuleNotFoundMatcher(): (err: unknown, specifier: string) => boolean {
  const source = readFileSync(launcherUrl, "utf8");
  const match = source.match(
    /const isModuleNotFoundError =[\s\S]*?\nconst installProcessWarningFilter =/,
  );
  if (!match) {
    throw new Error("failed to find launcher module-not-found helpers");
  }

  const helperSource = match[0]
    .replace(/\nconst installProcessWarningFilter =$/, "")
    .replaceAll("import.meta.url", "importMetaUrl");
  const context = {
    fileURLToPath,
    importMetaUrl: launcherUrl.href,
    URL,
  };
  vm.runInNewContext(`${helperSource}\nglobalThis.result = isDirectModuleNotFoundError;`, context);
  return (context as typeof context & { result: (err: unknown, specifier: string) => boolean })
    .result;
}

describe("openclaw launcher module-not-found matching", () => {
  it("accepts Bun direct import misses that omit ERR_MODULE_NOT_FOUND", () => {
    const isDirectModuleNotFoundError = loadDirectModuleNotFoundMatcher();
    const err = new Error(
      `Cannot find module './dist/warning-filter.js' from '${fileURLToPath(launcherUrl)}'`,
    );

    expect(isDirectModuleNotFoundError(err, "./dist/warning-filter.js")).toBe(true);
  });

  it("does not treat unrelated Bun import misses as the requested direct miss", () => {
    const isDirectModuleNotFoundError = loadDirectModuleNotFoundMatcher();
    const err = new Error(`Cannot find module './missing.js' from '${fileURLToPath(launcherUrl)}'`);

    expect(isDirectModuleNotFoundError(err, "./dist/warning-filter.js")).toBe(false);
  });
});
