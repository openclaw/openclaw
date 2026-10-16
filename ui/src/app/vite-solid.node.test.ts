// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { assert, expect, it } from "vitest";
import { controlUiSolidPlugin } from "../../config/control-ui-solid.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it.each([
  { command: "serve" as const, mode: "test", vitest: true },
  { command: "serve" as const, mode: "test", vitest: false },
  { command: "build" as const, mode: "production", vitest: false },
])("limits the client-runtime override to Vitest ($command/$mode/$vitest)", async (entry) => {
  const config = await resolveConfig(
    {
      root,
      configFile: false,
      envDir: false,
      mode: entry.mode,
      plugins: controlUiSolidPlugin(),
      ...(entry.vitest ? { test: { environment: "node" } } : {}),
    },
    entry.command,
  );
  const runtimeAliases = config.resolve.alias.filter(
    (alias) => alias.find instanceof RegExp && alias.find.test("@solidjs/web"),
  );
  expect(runtimeAliases.map((alias) => path.basename(alias.replacement))).toEqual(
    entry.vitest ? ["web.dev.js"] : [],
  );
  if (entry.vitest) {
    const ssr = config.environments.ssr;
    assert(ssr, "Vite must resolve the SSR environment");
    expect(config.test?.environment).toBe("node");
    expect(ssr.resolve.conditions).not.toContain("browser");
    expect(ssr.resolve.externalConditions).not.toContain("browser");
  }
});
