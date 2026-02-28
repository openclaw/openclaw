import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type RelayCheckResponse = {
  status?: number;
  ok?: boolean;
  error?: string;
  contentType?: string;
  json?: unknown;
};

type RelayCheckStatus =
  | { action: "throw"; error: string }
  | { action: "status"; kind: "ok" | "error"; message: string };

type RelayCheckExceptionStatus = { kind: "error"; message: string };

type OptionsValidationModule = {
  classifyRelayCheckResponse: (
    res: RelayCheckResponse | null | undefined,
    port: number,
  ) => RelayCheckStatus;
  classifyRelayCheckException: (err: unknown, port: number) => RelayCheckExceptionStatus;
};

const require = createRequire(import.meta.url);
const OPTIONS_VALIDATION_MODULE = "../../assets/chrome-extension/options-validation.js";

async function loadOptionsValidation(): Promise<OptionsValidationModule> {
  try {
    return require(OPTIONS_VALIDATION_MODULE) as OptionsValidationModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unexpected token 'export'")) {
      throw error;
    }
    return (await import(OPTIONS_VALIDATION_MODULE)) as OptionsValidationModule;
  }
}

const { classifyRelayCheckException, classifyRelayCheckResponse } = await loadOptionsValidation();

describe("chrome extension options validation", () => {
  it("maps 401 response to token rejected error", () => {
    const result = classifyRelayCheckResponse({ status: 401, ok: false }, 18792);
    expect(result).toEqual({
      action: "status",
      kind: "error",
      message: "Gateway token rejected. Check token and save again.",
    });
  });

  it("maps non-json 200 response to wrong-port error", () => {
    const result = classifyRelayCheckResponse(
      { status: 200, ok: true, contentType: "text/html; charset=utf-8", json: null },
      18792,
    );
    expect(result).toEqual({
      action: "status",
      kind: "error",
      message:
        "Wrong port: this is likely the gateway, not the relay. Use gateway port + 3 (for gateway 18789, relay is 18792).",
    });
  });

  it("maps json response without CDP keys to wrong-port error", () => {
    const result = classifyRelayCheckResponse(
      { status: 200, ok: true, contentType: "application/json", json: { ok: true } },
      18792,
    );
    expect(result).toEqual({
      action: "status",
      kind: "error",
      message:
        "Wrong port: expected relay /json/version response. Use gateway port + 3 (for gateway 18789, relay is 18792).",
    });
  });

  it("maps valid relay json response to success", () => {
    const result = classifyRelayCheckResponse(
      {
        status: 200,
        ok: true,
        contentType: "application/json",
        json: { Browser: "Chrome/136", "Protocol-Version": "1.3" },
      },
      19004,
    );
    expect(result).toEqual({
      action: "status",
      kind: "ok",
      message: "Relay reachable and authenticated at http://127.0.0.1:19004/",
    });
  });

  it("maps syntax/json exceptions to wrong-endpoint error", () => {
    const result = classifyRelayCheckException(new Error("SyntaxError: Unexpected token <"), 18792);
    expect(result).toEqual({
      kind: "error",
      message:
        "Wrong port: this is not a relay endpoint. Use gateway port + 3 (for gateway 18789, relay is 18792).",
    });
  });

  it("maps generic exceptions to relay unreachable error", () => {
    const result = classifyRelayCheckException(new Error("TypeError: Failed to fetch"), 18792);
    expect(result).toEqual({
      kind: "error",
      message:
        "Relay not reachable/authenticated at http://127.0.0.1:18792/. Start OpenClaw browser relay and verify token.",
    });
  });
});
