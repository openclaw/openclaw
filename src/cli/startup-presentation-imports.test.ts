import { expect, it, vi } from "vitest";

const clackLoaded = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", async (importOriginal) => {
  const prompts = await importOriginal<typeof import("@clack/prompts")>();
  clackLoaded();
  return prompts;
});

it("loads the prompt renderer for progress without loading it from shared config startup", async () => {
  await import("./program/config-guard.js");
  await import("../commands/startup-config-preflight.js");
  expect(clackLoaded).not.toHaveBeenCalled();

  await import("./progress.js");
  expect(clackLoaded).toHaveBeenCalledOnce();
});
