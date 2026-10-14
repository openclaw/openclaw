import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeSetupStagingRoot } from "./setup-staging-cleanup.js";

vi.mock("node:fs/promises", () => {
  const rm = vi.fn();
  return { default: { rm }, rm };
});

const retryImmediately = [0, 0, 0];
const rmMock = () => vi.mocked(fs.rm);

function lockedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code });
}

describe("removeSetupStagingRoot", () => {
  afterEach(() => rmMock().mockReset());

  it("retries a locked removal and succeeds", async () => {
    rmMock().mockRejectedValueOnce(lockedError("EBUSY")).mockResolvedValue(undefined);

    await expect(removeSetupStagingRoot("/tmp/staging", retryImmediately)).resolves.toBeUndefined();
    expect(rmMock()).toHaveBeenCalledTimes(2);
  });

  it("keeps onboarding going when the staging directory stays locked", async () => {
    rmMock().mockRejectedValue(lockedError("EBUSY"));

    await expect(removeSetupStagingRoot("/tmp/staging", retryImmediately)).resolves.toBeUndefined();
    expect(rmMock()).toHaveBeenCalledTimes(retryImmediately.length + 1);
  });

  it("does not retry an unrelated removal failure", async () => {
    rmMock().mockRejectedValue(lockedError("EACCES"));

    await expect(removeSetupStagingRoot("/tmp/staging", retryImmediately)).resolves.toBeUndefined();
    expect(rmMock()).toHaveBeenCalledTimes(1);
  });

  it("removes the staging directory on the first try", async () => {
    rmMock().mockResolvedValue(undefined);

    await removeSetupStagingRoot("/tmp/staging", retryImmediately);
    expect(rmMock()).toHaveBeenCalledTimes(1);
  });
});
