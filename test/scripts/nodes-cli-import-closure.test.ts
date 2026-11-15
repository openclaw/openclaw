import { expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";

it("keeps nodes command registration free of the Gateway request runtime", () => {
  const closure = collectRuntimeImportClosure(process.cwd(), ["src/cli/nodes-cli/register.ts"]);
  expect(closure.filter((file) => file === "src/gateway/call.ts")).toEqual([]);
});
