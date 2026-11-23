import { describe, expect, it } from "vitest";
import {
  TailscaleServePathPermissionError,
  isTailscaleServePathPermissionMessage,
} from "./tailscale-serve-path-permission-error.js";

describe("TailscaleServePathPermissionError", () => {
  it("matches 401 Unauthorized path/socket serve config errors", () => {
    expect(
      isTailscaleServePathPermissionMessage(
        "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket",
      ),
    ).toBe(true);
    expect(isTailscaleServePathPermissionMessage("Serve is not enabled on your tailnet.")).toBe(
      false,
    );
  });

  it("preserves the diagnostic message", () => {
    const err = new TailscaleServePathPermissionError("401 Unauthorized: must be root");
    expect(err.name).toBe("TailscaleServePathPermissionError");
    expect(err.message).toBe("401 Unauthorized: must be root");
  });
});
