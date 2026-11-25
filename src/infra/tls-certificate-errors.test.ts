import { describe, expect, it } from "vitest";
import { inspectTlsCertificateError } from "./tls-certificate-errors.js";

describe("inspectTlsCertificateError", () => {
  it.each(["HOSTNAME_MISMATCH"])("classifies hostname mismatch code %s", (code) => {
    expect(inspectTlsCertificateError({ code, message: "TLS validation failed" })).toEqual({
      kind: "hostname_mismatch",
      code,
      message: "TLS validation failed",
    });
  });

  it("walks AggregateError members", () => {
    const certificateError = Object.assign(new Error("certificate revoked"), {
      code: "CERT_REVOKED",
    });
    const error = new AggregateError(
      [new Error("connection failed"), certificateError],
      "request failed",
    );

    expect(inspectTlsCertificateError(error)).toEqual({
      kind: "certificate_invalid",
      code: "CERT_REVOKED",
      message: "certificate revoked",
    });
  });

  it.each([
    ["self-signed certificate in certificate chain", "certificate_invalid"],
    [
      "Hostname/IP does not match certificate's altnames: Host: api.example.com",
      "hostname_mismatch",
    ],
  ] as const)("classifies message-only failure %s", (message, kind) => {
    expect(inspectTlsCertificateError(message)).toEqual({ kind, message });
  });

  it.each([{ code: "OUT_OF_MEM", message: "out of memory" }])(
    "does not classify transient or non-certificate failure",
    (error) => {
      expect(inspectTlsCertificateError(error)).toBeNull();
    },
  );
});
