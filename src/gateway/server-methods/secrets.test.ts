import { describe, expect, it, vi } from "vitest";
import { createSecretsHandlers } from "./secrets.js";

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await params.handlers["secrets.reload"]({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

describe("secrets handlers", () => {
  it("responds with warning count on successful reload", async () => {
    const handlers = createSecretsHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const handlers = createSecretsHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("reload failed")),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
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
