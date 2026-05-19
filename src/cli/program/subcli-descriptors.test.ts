import { afterEach, describe, expect, it, vi } from "vitest";
import { getSubCliDescriptors, getSubCliEntries } from "./subcli-descriptors.js";

const isPrivateQaCliEnabledMock = vi.hoisted(() => vi.fn());

vi.mock("./private-qa-cli.js", () => ({
  isPrivateQaCliEnabled: isPrivateQaCliEnabledMock,
}));

describe("getSubCliDescriptors (#83927)", () => {
  afterEach(() => {
    isPrivateQaCliEnabledMock.mockReset();
  });

  it("hides the qa command when the private-qa flag is disabled", () => {
    isPrivateQaCliEnabledMock.mockReturnValue(false);
    const descriptors = getSubCliDescriptors();
    expect(descriptors.find((d) => d.name === "qa")).toBeUndefined();
  });

  it("includes the qa command when the private-qa flag is enabled", () => {
    isPrivateQaCliEnabledMock.mockReturnValue(true);
    const descriptors = getSubCliDescriptors();
    expect(descriptors.find((d) => d.name === "qa")).toBeDefined();
  });

  it("agrees with getSubCliEntries on qa visibility under both flag states", () => {
    isPrivateQaCliEnabledMock.mockReturnValue(false);
    const offDescriptors = getSubCliDescriptors();
    const offEntries = getSubCliEntries();
    expect(offDescriptors.map((d) => d.name).sort()).toEqual(
      offEntries.map((d) => d.name).sort(),
    );

    isPrivateQaCliEnabledMock.mockReturnValue(true);
    const onDescriptors = getSubCliDescriptors();
    const onEntries = getSubCliEntries();
    expect(onDescriptors.map((d) => d.name).sort()).toEqual(
      onEntries.map((d) => d.name).sort(),
    );
  });
});
