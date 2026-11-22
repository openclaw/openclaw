import { expect, it, vi } from "vitest";
import { getModelTransportContext, withModelTransportContext } from "./model-transport-context.js";

it("shares request context across module copies without leaking nested or concurrent scopes", async () => {
  vi.resetModules();
  const other = await import("./model-transport-context.js");
  expect(other.withModelTransportContext).not.toBe(withModelTransportContext);
  await Promise.all(
    ["first:1", "second:2"].map((requestId) =>
      other.withModelTransportContext({ requestId }, async () => {
        await Promise.resolve();
        expect(getModelTransportContext()?.requestId).toBe(requestId);
        withModelTransportContext({ requestId: "nested:3" }, () => {
          expect(other.getModelTransportContext()?.requestId).toBe("nested:3");
        });
        expect(other.getModelTransportContext()?.requestId).toBe(requestId);
      }),
    ),
  );
  expect(getModelTransportContext()).toBeUndefined();
  expect(other.getModelTransportContext()).toBeUndefined();
});
