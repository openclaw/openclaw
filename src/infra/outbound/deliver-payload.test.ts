import { expect, it } from "vitest";
import { stripInternalRuntimeScaffoldingFromPayload } from "./deliver-payload.js";

it("preserves own __proto__ payload data in serialized output after stripping scaffolding", () => {
  const payload = {
    text: "visible",
    channelData: {
      ["__proto__"]: { note: "<previous_response>hidden</previous_response>visible" },
    },
  };

  const projected = stripInternalRuntimeScaffoldingFromPayload(payload);

  expect(JSON.stringify(projected)).toBe(
    '{"text":"visible","channelData":{"__proto__":{"note":"visible"}}}',
  );
});
