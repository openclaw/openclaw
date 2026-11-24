import { afterEach, beforeEach, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { profileRequest } from "./diagnostics.test-support.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

it("serves process capabilities to read-only operators and rejects missing authority", async () => {
  const allowed = profileRequest({ method: "diagnostics.capabilities", scopes: ["operator.read"] });
  await allowed.pending;
  expect(allowed.respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      schemaVersion: 1,
      process: expect.objectContaining({ platform: process.platform, arch: process.arch }),
    }),
    undefined,
  );
  const denied = profileRequest({ method: "diagnostics.capabilities", scopes: [] });
  await denied.pending;
  expect(denied.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
});

it("rejects capability parameters instead of starting an active probe", async () => {
  const call = profileRequest({
    method: "diagnostics.capabilities",
    scopes: ["operator.read"],
    params: { probe: true },
  });
  await call.pending;
  expect(call.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("empty params"),
    }),
  );
});
