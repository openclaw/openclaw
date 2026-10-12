import { afterEach, expect, it, vi } from "vitest";
import { createChildAdapter } from "./child.js";
import { createStubChild, readyChildAdapter } from "./child.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("../../spawn-utils.js", () => ({ spawnWithFallback: spawnMock }));
const start = readyChildAdapter(createChildAdapter);
afterEach(() => vi.unstubAllEnvs());

it("reports actual root exit synchronously while output remains open", async () => {
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
  const stub = createStubChild();
  spawnMock.mockResolvedValue({ child: stub.child, usedFallback: false });
  const adapter = await start({ argv: ["synthetic-child"], stdinMode: "pipe-open" });
  const onExit = vi.fn();
  adapter.onExit(onExit);
  stub.emitExit(1);
  expect(onExit).toHaveBeenCalledExactlyOnceWith(1, null);
  const late = vi.fn();
  adapter.onExit(late);
  expect(late).toHaveBeenCalledExactlyOnceWith(1, null);
  const settled = vi.fn();
  void adapter.wait().then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  stub.emitClose(1);
  await adapter.wait();
  adapter.dispose();
});
