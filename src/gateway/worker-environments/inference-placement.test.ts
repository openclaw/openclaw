import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../../config/zod-schema.js";
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

  it("resolves explicit worker inference without rewriting its snapshot", () => {
    const environment = {
      providerId: "device",
      profileSnapshot: { settings: { device: "paired-node", inference: "worker" } },
    };
    const original = structuredClone(environment);
    expect(workerInferencePlacement(environment)).toBe("worker");
    expect(environment).toEqual(original);
  });

  it.each(["runtime-local", "unknown", "native", null, false, 1, { mode: "worker" }])(
    "rejects invalid paired-device placement %j",
    (inference) => {
      expect(() =>
        workerInferencePlacement({
          providerId: "device",
          profileSnapshot: { settings: { inference } },
        }),
      ).toThrow('settings.inference must be "gateway" or "worker"');
    },
  );

  it.each([
    undefined,
    "gateway",
    "worker",
    "runtime-local",
    "native",
    "vendor-mode",
    false,
    null,
    1,
    { mode: "remote" },
  ])("preserves accepted provider-owned inference settings %j", (inference) => {
    const profile = {
      provider: "custom-provider",
      settings: inference === undefined ? {} : { inference },
    };
    expect(
      OpenClawSchema.safeParse({ cloudWorkers: { profiles: { custom: profile } } }).success,
    ).toBe(true);
    expect(
      workerInferencePlacement({ providerId: profile.provider, profileSnapshot: profile }),
    ).toBe("gateway");
  });
});
