import { describe, expect, it } from "vitest";
import { workerInferencePlacement } from "./inference-placement.js";

describe("recorded worker inference placement", () => {
  it.each([undefined, "gateway"])(
    "preserves %s Gateway inference for every provider",
    (inference) => {
      for (const providerId of ["device", "static-ssh"]) {
        expect(
          workerInferencePlacement({ providerId, profileSnapshot: { settings: { inference } } }),
        ).toBe("gateway");
      }
    },
  );

  it.each(["worker", "runtime-local"])(
    "resolves explicit %s without rewriting its snapshot",
    (inference) => {
      const environment = {
        providerId: "device",
        profileSnapshot: { settings: { device: "paired-node", inference } },
      };
      const original = structuredClone(environment);
      expect(workerInferencePlacement(environment)).toBe("worker");
      expect(environment).toEqual(original);
    },
  );

  it.each(["worker", "runtime-local", "unknown", null, false, 1])(
    "never turns invalid explicit %s into Gateway inference",
    (inference) => {
      expect(() =>
        workerInferencePlacement({
          providerId: "static-ssh",
          profileSnapshot: { settings: { inference } },
        }),
      ).toThrow();
      if (inference !== "worker" && inference !== "runtime-local") {
        expect(() =>
          workerInferencePlacement({
            providerId: "device",
            profileSnapshot: { settings: { inference } },
          }),
        ).toThrow();
      }
    },
  );
});
