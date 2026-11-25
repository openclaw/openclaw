import { expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";

it("keeps Canvas command registration free of the Gateway request runtime", () => {
  const closure = collectRuntimeImportClosure(process.cwd(), ["extensions/canvas/src/cli.ts"]);
  expect(closure.filter((file) => file === "src/gateway/call.ts")).toEqual([]);
});
