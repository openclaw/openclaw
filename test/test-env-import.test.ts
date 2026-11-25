import { expect, it } from "vitest";
import { execNodeEvalSync } from "../src/test-utils/node-process.js";

it("keeps JSON5 unloaded during hermetic test setup", () => {
  const moduleUrl = new URL("./test-env.ts", import.meta.url).href;
  const output = execNodeEvalSync(
    `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const { installTestEnv } = await import(${JSON.stringify(moduleUrl)});
      const testEnv = installTestEnv({ mode: "hermetic" });
      try {
        process.stdout.write(String(require.cache[require.resolve("json5")] === undefined));
      } finally {
        testEnv.cleanup();
      }
    `,
    { imports: ["tsx"], timeout: 15_000 },
  );

  expect(output).toBe("true");
});
