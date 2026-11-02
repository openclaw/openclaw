import assert from "node:assert/strict";
import { createWorkerTaskControl } from "@openclaw/worker-runtime/worker";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it, vi } from "vitest";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import type { ImageProcessorReply } from "./image-processor.types.js";
import "./image-processor.worker.js";

vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveWorkerTasks: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it("transfers Photon's owned PNG without copying either side of the BMP conversion", async () => {
  const registration = vi.mocked(serveWorkerTasks<ImageProcessorReply>).mock.calls[0];
  assert(registration);
  const [handler, options] = registration;
  const bmp = Uint8Array.from(
    Buffer.from(
      "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
      "base64",
    ),
  );
  const decode = vi.spyOn(photon.PhotonImage, "new_from_byteslice");
  const encode = vi.spyOn(photon.PhotonImage.prototype, "get_bytes");
  const reply = await handler(
    { kind: "bmpToPng", input: bmp },
    undefined,
    createWorkerTaskControl(new Int32Array(new SharedArrayBuffer(4)), () => true),
  );
  expect(reply.kind).toBe("bmpToPng");
  if (reply.kind !== "bmpToPng") {
    throw new Error("BMP conversion failed");
  }
  expect(decode.mock.calls[0]?.[0]).toBe(bmp);
  expect(reply.value.buffer).toBe(encode.mock.results[0]?.value.buffer);
  const received = structuredClone(reply, { transfer: options?.transferList?.(reply) });
  expect(reply.value.byteLength).toBe(0);
  const image = photon.PhotonImage.new_from_byteslice(received.value);
  try {
    expect([...image.get_raw_pixels()]).toEqual([255, 0, 0, 255]);
  } finally {
    image.free();
  }
});
