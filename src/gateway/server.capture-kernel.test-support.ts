import { expectDefined } from "@openclaw/normalization-core/expect";
import { vi } from "vitest";

export async function captureGatewayKernel(start: () => Promise<void>) {
  const module = await import("./server-kernel.js");
  const create = module.createGatewayKernel;
  let kernel: Awaited<ReturnType<typeof create>> | undefined;
  const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
    kernel = await create(...args);
    return kernel;
  });
  try {
    await start();
    return expectDefined(kernel, "started Gateway kernel");
  } finally {
    capture.mockRestore();
  }
}
