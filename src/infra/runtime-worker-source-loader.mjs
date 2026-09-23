import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import "tsx/esm";

// An earlier native TypeScript preload can select Node's CommonJS strip-only
// path before tsx's ESM hook registers. Transform only TypeScript in that path;
// compiled JavaScript must retain native require(ESM) and import-only exports.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (
      url.startsWith("file:") &&
      /\.[cm]?ts(?:\?|$)/u.test(url) &&
      (loaded.format === "commonjs" || loaded.format === "commonjs-typescript")
    ) {
      const source = loaded.source ?? readFileSync(new URL(url));
      return {
        ...loaded,
        format: "commonjs",
        source: stripTypeScriptTypes(
          typeof source === "string" ? source : new TextDecoder().decode(source),
          {
            mode: "transform",
            sourceUrl: url,
            sourceMap: true,
          },
        ),
      };
    }
    return loaded;
  },
});
