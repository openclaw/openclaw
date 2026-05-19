import { afterEach, describe, expect, it } from "vitest";
import { getSubCliDescriptors, getSubCliEntries } from "./subcli-descriptors.js";

describe("getSubCliDescriptors (#83927)", () => {
  const originalPrivateQaFlag = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

  afterEach(() => {
    if (originalPrivateQaFlag === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaFlag;
    }
  });

  it("hides the qa command when the private-qa flag is disabled", () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    const descriptors = getSubCliDescriptors();
    expect(descriptors.find((d) => d.name === "qa")).toBeUndefined();
  });

  it("includes the qa command when the private-qa flag is enabled", () => {
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    const descriptors = getSubCliDescriptors();
    expect(descriptors.find((d) => d.name === "qa")).toBeDefined();
  });

  it("agrees with getSubCliEntries on qa visibility under both flag states", () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    const offDescriptors = getSubCliDescriptors();
    const offEntries = getSubCliEntries();
    expect(offDescriptors.map((d) => d.name).toSorted()).toEqual(
      offEntries.map((d) => d.name).toSorted(),
    );

    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    const onDescriptors = getSubCliDescriptors();
    const onEntries = getSubCliEntries();
    expect(onDescriptors.map((d) => d.name).toSorted()).toEqual(
      onEntries.map((d) => d.name).toSorted(),
    );
  });
});
