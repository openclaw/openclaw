import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type OptimizerTarget = (...args: never[]) => unknown;

if (process.versions.bun) {
  const require = createRequire(import.meta.url);
  // Bun is optional; describe only the native optimizer API used by this setup.
  const { noInline } = require("bun:jsc") as { noInline: (target: OptimizerTarget) => void };
  const cssValuesOwner = path.join(
    path.dirname(require.resolve("jsdom/package.json")),
    "lib/jsdom/living/css/helpers/css-values.js",
  );
  const requireFromCssValues = createRequire(cssValuesOwner);
  const colorEntry = realpathSync(requireFromCssValues.resolve("@asamuzakjp/css-color"));
  const requireFromColor = createRequire(colorEntry);
  const tokenizerEntry = realpathSync(requireFromColor.resolve("@csstools/css-tokenizer"));
  // Load jsdom's native ESM instance; a Vite import can bind another tokenizer.
  const { tokenizer } = requireFromColor(tokenizerEntry) as {
    tokenizer: (input: { css: string }) => {
      endOfFile: OptimizerTarget;
    };
  };
  const instance = tokenizer({ css: "" });
  // This predicate shares its native executable with later instances. Keep only
  // the EOF check uninlined to avoid the pinned fork's ordered CSS loop.
  noInline(instance.endOfFile);
}
