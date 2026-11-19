import { expect, it } from "vitest";
import { parseGatewayPayload } from "./server-json.js";

it.each<[string | null | undefined, unknown]>([
  [undefined, undefined],
  [null, undefined],
  [" \t\n", undefined],
  [" null ", null],
  [" false ", false],
  [" 3 ", 3],
  [' "text" ', "text"],
  [" [1] ", [1]],
  [' {"ok":true} ', { ok: true }],
  [" {broken} ", { payloadJSON: " {broken} " }],
])("preserves decoded payload or original malformed input %j", (input, expected) => {
  expect(parseGatewayPayload(input)).toEqual(expected);
});
