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

async function invokeSecretsResolve(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
  commandName: unknown;
  targetIds: unknown;
}) {
  await params.handlers["secrets.resolve"]({
    req: { type: "req", id: "1", method: "secrets.resolve" },
    params: {
      commandName: params.commandName,
      targetIds: params.targetIds,
    },
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.resolve"]
    >[0]["respond"],
    context: {} as never,
  });
}

describe("secrets handlers", () => {
  function createHandlers(overrides?: {
    reloadSecrets?: () => Promise<{ warningCount: number }>;
    resolveSecrets?: (params: { commandName: string; targetIds: string[] }) => Promise<{
      assignments: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      diagnostics: string[];
      inactiveRefPaths: string[];
    }>;
  }) {
    const reloadSecrets = overrides?.reloadSecrets ?? (async () => ({ warningCount: 0 }));
    const resolveSecrets =
      overrides?.resolveSecrets ??
      (async () => ({
        assignments: [],
        diagnostics: [],
        inactiveRefPaths: [],
      }));
    return createSecretsHandlers({
      reloadSecrets,
      resolveSecrets,
    });
  }

  it("responds with warning count on successful reload", async () => {
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const handlers = createHandlers({
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

  it("resolves requested command secret assignments from the active snapshot", async () => {
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: "talk.providers.elevenlabs.apiKey",
          pathSegments: ["talk", "providers", "elevenlabs", "apiKey"],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: ["talk.providers.elevenlabs.apiKey"],
    });
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expect(resolveSecrets).toHaveBeenCalledWith({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      assignments: [
        {
          path: "talk.providers.elevenlabs.apiKey",
          pathSegments: ["talk", "providers", "elevenlabs", "apiKey"],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: ["talk.providers.elevenlabs.apiKey"],
    });
  });

  it("rejects invalid secrets.resolve params", async () => {
    const handlers = createHandlers();
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "",
      targetIds: "bad",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });

  it("rejects secrets.resolve params when targetIds entries are not strings", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey", 12],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "invalid secrets.resolve params: targetIds",
      }),
    );
  });

  it("rejects unknown secrets.resolve target ids", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["unknown.target"],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: 'invalid secrets.resolve params: unknown target id "unknown.target"',
      }),
    );
  });

  it("returns unavailable when secrets.resolve handler returns an invalid payload shape", async () => {
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [{ path: "talk.providers.elevenlabs.apiKey", pathSegments: [""], value: "sk" }],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
      }),
    );
  });
});
