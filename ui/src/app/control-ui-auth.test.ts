import { describe, expect, it } from "vitest";
import {
  resolveControlUiAuthCandidates,
  resolveControlUiAuthHeader,
  resolveControlUiAuthToken,
} from "./control-ui-auth.ts";

describe("resolveControlUiAuthToken", () => {
  it("prefers the rotated hello token over the WS device token", () => {
    expect(
      resolveControlUiAuthToken({
        hello: { auth: { deviceToken: "hello-token" } },
        deviceToken: "ws-device-token",
        settings: { token: "settings-token" },
        password: "pw",
      }),
    ).toBe("hello-token");
  });

  it("falls back to the WS device token when hello omits it (reconnect case)", () => {
    expect(
      resolveControlUiAuthToken({
        hello: { auth: { deviceToken: null } },
        deviceToken: "ws-device-token",
        settings: { token: "settings-token" },
        password: "pw",
      }),
    ).toBe("ws-device-token");
  });

  it("prefers the WS device token over the settings token", () => {
    expect(
      resolveControlUiAuthToken({
        deviceToken: "ws-device-token",
        settings: { token: "settings-token" },
      }),
    ).toBe("ws-device-token");
  });

  it("falls back to settings then password when no device token is present", () => {
    expect(resolveControlUiAuthToken({ settings: { token: "settings-token" } })).toBe(
      "settings-token",
    );
    expect(resolveControlUiAuthToken({ password: "pw" })).toBe("pw");
  });

  it("returns null when every candidate is absent or blank", () => {
    expect(resolveControlUiAuthToken({})).toBeNull();
    expect(
      resolveControlUiAuthToken({ deviceToken: "   ", settings: { token: "" }, password: null }),
    ).toBeNull();
  });

  it("rejects tokens that would smuggle CRLF into the header", () => {
    expect(resolveControlUiAuthToken({ deviceToken: "bad\r\ntoken" })).toBeNull();
  });
});

describe("resolveControlUiAuthHeader", () => {
  it("wraps the resolved token as a Bearer header", () => {
    expect(resolveControlUiAuthHeader({ deviceToken: "ws-device-token" })).toBe(
      "Bearer ws-device-token",
    );
  });

  it("returns null when no candidate resolves", () => {
    expect(resolveControlUiAuthHeader({})).toBeNull();
  });
});

describe("resolveControlUiAuthCandidates", () => {
  it("orders candidates hello > deviceToken > settings > password", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "hello-token" } },
        deviceToken: "ws-device-token",
        settings: { token: "settings-token" },
        password: "pw",
      }),
    ).toEqual(["hello-token", "ws-device-token", "settings-token", "pw"]);
  });

  it("dedupes candidates that share a value", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "same" } },
        deviceToken: "same",
        settings: { token: "same" },
      }),
    ).toEqual(["same"]);
  });

  it("drops blank and CRLF-tainted candidates while sanitizing", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "  " } },
        deviceToken: "bad\ntoken",
        settings: { token: "settings-token" },
        password: "",
      }),
    ).toEqual(["settings-token"]);
  });
});
