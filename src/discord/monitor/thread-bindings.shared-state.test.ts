import { createJiti } from "jiti";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __testing as threadBindingsTesting,
  createThreadBindingManager,
  getThreadBindingManager,
} from "./thread-bindings.js";

describe("thread binding manager state", () => {
  beforeEach(() => {
    threadBindingsTesting.resetThreadBindingsForTests();
  });

  it("shares managers between ESM and Jiti-loaded module instances", () => {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
    });
    const viaJiti = jiti("./thread-bindings.ts") as {
      getThreadBindingManager: typeof getThreadBindingManager;
    };

    createThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    expect(getThreadBindingManager("work")).not.toBeNull();
    expect(viaJiti.getThreadBindingManager("work")).not.toBeNull();
  });
});
