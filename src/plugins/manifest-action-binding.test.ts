import { expect, it } from "vitest";
import { normalizeManifestDashboard } from "./manifest-setup-normalizers.js";
const action = {
  id: "audio",
  method: "device-controls.audio",
  description: "Play on an approved device",
};
it("retains required fixed action fields in the trusted plugin declaration", () => {
  const dashboard = {
    actionVerbs: [{ ...action, requiredActionBindingParams: ["nodeId", "operationId"] }],
  };
  expect(normalizeManifestDashboard(dashboard)).toEqual({ ok: true, dashboard });
});
it.each([[], ["nodeId", "nodeId"], ["__proto__"], [""], [false], "nodeId"].map((value) => [value]))(
  "rejects invalid required action binding fields %j",
  (value) => {
    expect(
      normalizeManifestDashboard({
        actionVerbs: [{ ...action, requiredActionBindingParams: value }],
      }).ok,
    ).toBe(false);
  },
);
