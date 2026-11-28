import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliTtyMock } from "./test-runtime-capture.js";

const promptYesNo = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./prompt.js", () => ({ promptYesNo }));

const { set: setTty, restore: restoreTty } = createCliTtyMock();

describe("resolveClawHubInstallConfirmation", () => {
  afterEach(() => {
    promptYesNo.mockClear();
    restoreTty();
  });

  it("prompts a human terminal with a generic install confirmation", async () => {
    setTty(true);
    const { resolveClawHubInstallConfirmation } = await import("./clawhub-install-confirmation.js");

    const confirm = resolveClawHubInstallConfirmation();

    expect(confirm).toBeTypeOf("function");
    await expect(confirm?.()).resolves.toBe(true);
    expect(promptYesNo).toHaveBeenCalledWith("Proceed with installation?");
  });

  it("does not prompt non-interactive callers", async () => {
    setTty(false);
    const { resolveClawHubInstallConfirmation } = await import("./clawhub-install-confirmation.js");

    expect(resolveClawHubInstallConfirmation()).toBeUndefined();
  });
});
