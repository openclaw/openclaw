/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { openClawIdErrorToast, openClawIdUiError } from "./ui-error.ts";

// Match the Gateway request error shape, not backend message substrings.
function refusal(code: string, message = "internal diagnostic") {
  return Object.assign(new Error(message), { details: { code } });
}

describe("OpenClaw ID display errors", () => {
  it.each([
    ["preview_access_required", "private preview"],
    ["issuer_invalid", "Sign-in stopped because OpenClaw ID could not be verified"],
    ["id_token_invalid", "your account could not be verified"],
    ["registration_mismatch", "does not match the saved ownership details"],
    ["target_mismatch", "could not be verified"],
    ["wrong_domain", "claw address did not match"],
    ["signed_out", "sign-in expired"],
    ["seq_conflict", "Access changed"],
    ["invite_not_pending", "no longer waiting for approval"],
    ["expired", "This access approval expired"],
  ])("maps %s while keeping raw detail separate", (code, expected) => {
    const result = openClawIdUiError(refusal(code));
    expect(result.message).toContain(expected);
    expect(result.message).not.toContain("internal diagnostic");
    expect(result.detail).toBe("internal diagnostic");
  });

  it("keeps local-only instructions specific to sign-in and setup", () => {
    const error = refusal("not_local_operator");
    expect(openClawIdUiError(error, "signIn").message).toMatch(/^Sign in on the computer/);
    expect(openClawIdUiError(error, "setup").message).toMatch(/^To turn on remote access/);
  });

  it("does not infer causes or success from arbitrary prose or shared codes", () => {
    expect(openClawIdUiError(new Error("issuer_invalid: all fine"), "remove").message).toContain(
      "Could not confirm",
    );
    expect(openClawIdUiError(refusal("malformed", "certificate expired")).message).toContain(
      "request could not be accepted",
    );
    expect(openClawIdUiError(refusal("expired")).message).not.toContain("This browser’s");
    expect(openClawIdUiError(new Error("failed"), "approval").message).toContain(
      "If the new browser has access",
    );
  });

  it("reads publication codes and redacts secrets before bounding diagnostic text", () => {
    const result = openClawIdUiError({
      code: "registration_mismatch",
      message:
        "token=private-token https://example.test/?code=private-code#private-fragment OCK1" +
        "A".repeat(38) +
        "\n" +
        "x".repeat(3000),
    });
    expect(result.message).toContain("saved ownership details");
    expect(result.detail).not.toMatch(/private-token|private-code|private-fragment|OCK1A/);
    expect(result.detail.length).toBeLessThanOrEqual(2000);
  });

  it("uses inert text and a closed native disclosure for toast diagnostics", () => {
    const node = openClawIdErrorToast(
      refusal("issuer_invalid", "<img src=x onerror=alert(1)>"),
      "signIn",
    );
    expect(node.firstElementChild?.textContent).toContain("could not be verified");
    expect(node.querySelector("details")?.open).toBe(false);
    expect(node.querySelector("summary")?.textContent).toBe("Technical details");
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("details")?.textContent).toContain("<img");
  });
});
