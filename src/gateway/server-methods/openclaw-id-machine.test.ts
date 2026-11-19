import { expect, it, vi } from "vitest";
import type { OpenClawIdService } from "../openclaw-id/service.js";
import { handleOpenClawIdMachineAction } from "./openclaw-id-machine.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Machine-only actions are refused over the tunnel before the service is asked anything.
function setup() {
  const respond = vi.fn();
  const service = {
    rebind: vi.fn(async () => ({ ok: true })),
    unlink: {
      preview: vi.fn(async () => ({ hostname: "h", people: 0, devices: 1 })),
      run: vi.fn(async () => ({ ok: true, unlinked: true })),
    },
  };
  // SAFETY: the handler reads only rebind and unlink from the service and respond from opts.
  const opts = { respond } as unknown as GatewayRequestHandlerOptions;
  return { respond, service, opts, typed: service as unknown as OpenClawIdService };
}

it.each(["unlink_preview", "unlink", "rebind_prepare"])(
  "refuses %s over the tunnel",
  async (action) => {
    const { respond, service, opts, typed } = setup();
    await handleOpenClawIdMachineAction(opts, typed, "tunnel", { action });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ details: { code: "not_local_operator" } }),
    );
    expect(service.unlink.run).not.toHaveBeenCalled();
    expect(service.unlink.preview).not.toHaveBeenCalled();
    expect(service.rebind).not.toHaveBeenCalled();
  },
);

it("runs unlink on direct loopback", async () => {
  const { respond, service, opts, typed } = setup();
  await handleOpenClawIdMachineAction(opts, typed, "local_operator", {
    action: "unlink",
    clawId: "c".repeat(32),
  });
  expect(service.unlink.run).toHaveBeenCalledWith("local_operator", "c".repeat(32));
  expect(respond).toHaveBeenCalledWith(true, { ok: true, unlinked: true });
});
