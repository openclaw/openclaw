import { describe, expect, it, vi } from "vitest";
import { createSecretsHandlers } from "./secrets.js";

describe("secrets handlers", () => {
  it("responds with warning count on successful reload", async () => {
    const handlers = createSecretsHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await handlers["secrets.reload"]({
      req: { type: "req", id: "1", method: "secrets.reload" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const handlers = createSecretsHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("reload failed")),
    });
    const respond = vi.fn();
    await handlers["secrets.reload"]({
      req: { type: "req", id: "1", method: "secrets.reload" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "Error: reload failed",
      }),
    );
  });
});
