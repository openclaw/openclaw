import { expect, it } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";

it("retains import facts without retaining their source files", () => {
  const output = execNodeEvalSync(
    String.raw`
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { getHeapSnapshot } from "node:v8";
      import { visitPluginSourceReferences } from "./src/plugins/plugin-source-references.ts";

      const markers = [];
      globalThis.heldFacts = ["static", "dynamic"].map((kind) => {
        const marker = "/*" + randomUUID();
        markers.push(marker);
        const specifier = "./long-reference-" + kind + "-child.mjs";
        const statement = kind === "static"
          ? "export * from " + JSON.stringify(specifier)
          : "import(" + JSON.stringify(specifier) + ")";
        const observed = [];
        const authored = visitPluginSourceReferences(
          "fixture.mjs",
          marker + "x".repeat(128 * 1024) + "*/\n" + statement,
          () => { throw new Error("Plain JavaScript should use the native parser"); },
          (value, type) => observed.push([type, value]),
        );
        assert.deepEqual(observed, [["import", specifier]]);
        assert.deepEqual([...authored], kind === "static" ? [specifier] : []);
        return { authored, observed };
      });

      // A later scan replaces parser and regexp scratch without releasing held facts.
      const unusual = "./another-reference-\ud800.mjs";
      const next = visitPluginSourceReferences("next.mjs", "import " + JSON.stringify(unusual),
        () => { throw new Error("unexpected transform"); }, () => {});
      assert.deepEqual([...next], [unusual]);
      // Snapshot only the fresh synthetic process. A surviving module has its unique
      // marker followed by padding, even when V8 truncates string names in the graph.
      await new Promise((resolve) => setImmediate(resolve));
      const chunks = [];
      for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
      const { strings } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      console.log(JSON.stringify(markers.map((marker) =>
        strings.some((value) => value.startsWith(marker + "xxxxxxxx")))));
    `,
    { imports: ["./scripts/tsx.mjs"], timeout: 30_000 },
  );
  expect(JSON.parse(output)).toEqual([false, false]);
});
