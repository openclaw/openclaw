import { expect, it } from "vitest";
import { parseInstallationCountCapability } from "./telemetry-installation-count.js";

it("accepts the receiver's eight-digit bound and requires a complete capability match", () => {
  expect(parseInstallationCountCapability("1;99999999")).toBe(99999999);
  expect(parseInstallationCountCapability("1;100000000")).toBeNull();
  expect(parseInstallationCountCapability("1;20688\n")).toBeNull();
});
