import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createChildAdapter } from "./child.js";
import { createStubChild, readyChildAdapter, setPlatform } from "./child.test-support.js";

const { spawnMock, signalMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), signalMock: vi.fn() }));
vi.mock("../../spawn-utils.js", () => ({ spawnWithFallback: spawnMock }));
vi.mock("../../kill-tree.js", () => ({ signalProcessTree: signalMock }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const start = readyChildAdapter(createChildAdapter);
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
});

it("does not signal a retired child when secret delivery fails after close", async () => {
  setPlatform("win32");
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
  const { child, killMock, emitClose } = createStubChild();
  const deliveryError = new Error("secret delivery failed after child close");
  const secretStream = new Writable({
    write(_chunk, _encoding, callback) {
      emitClose(0);
      setImmediate(() => callback(deliveryError));
    },
  });
  Object.defineProperty(child, "stdio", {
    value: [child.stdin, child.stdout, child.stderr, secretStream],
    configurable: true,
  });
  spawnMock.mockResolvedValue({ child, usedFallback: false });

  await expect(
    start({
      argv: ["synthetic-command"],
      secretInput: { fd: 3, createData: () => Buffer.from("synthetic-secret") },
    }),
  ).rejects.toBe(deliveryError);
  expect(signalMock).not.toHaveBeenCalled();
  expect(killMock).not.toHaveBeenCalled();
});
