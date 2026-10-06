import { expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

it("rejects non-boolean node auto-approval with the supported choices", () => {
  expect(
    validateConfigObject({
      gateway: { nodes: { pairing: { autoApproveLocal: "false" } } },
    }),
  ).toMatchObject({
    ok: false,
    issues: [
      expect.objectContaining({
        path: "gateway.nodes.pairing.autoApproveLocal",
        allowedValues: ["true", "false"],
      }),
    ],
  });
});
