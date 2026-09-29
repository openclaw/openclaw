import { describe, expect, it, vi } from "vitest";

vi.mock("../../infra/windows-appcontainer-spawn-guard.js", () => ({
  assertWindowsChildPipesSupported: () => {
    throw new Error("AppContainer libuv guard");
  },
}));

vi.mock("../../infra/runtime-process-url.js", () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///relay.js"),
}));

import { prepareServiceChildRelay } from "./service-child-relay-preparation.js";

describe("prepareServiceChildRelay", () => {
  it("fails before reserving stdio when the child-pipe guard rejects", () => {
    expect(() =>
      prepareServiceChildRelay({
        command: "node",
        args: [],
        stdinMode: "pipe-closed",
        oomScoreWrapperSelected: false,
      } as never),
    ).toThrow("AppContainer libuv guard");
  });
});
